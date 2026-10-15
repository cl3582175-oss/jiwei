import { net, safeStorage } from 'electron'
import { and, asc, eq, isNull } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb, getSqlite } from '../../db'
import { providers } from '../../db/schema'
import { emit } from '../../events'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { PROVIDER_PRESETS, resolveCaps, validContext, type ModelCaps, type ModelCapsOverride, type ProviderKind } from '@shared/ai'
import type { ProviderInfo, ProviderInput, ProviderTestResult } from '@shared/types'

// 模型服务商管理。
// 网络请求使用 Electron net.fetch：遵循系统代理设置（国内访问海外服务时常用）。
// API Key 只在主进程中解密使用：渲染进程永远拿不到明文，只能知道“是否已设置”及末四位。

type Row = typeof providers.$inferSelect

function encrypt(key: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法安全保存 API Key')
  return safeStorage.encryptString(key)
}

export function decryptKey(row: Row): string | null {
  if (!row.apiKeyEnc) return null
  try {
    return safeStorage.decryptString(Buffer.from(row.apiKeyEnc))
  } catch (e) {
    log.error('[providers] decrypt failed', row.id, e)
    return null
  }
}

function parseCaps(r: Row): Record<string, ModelCapsOverride> {
  try {
    return JSON.parse(r.modelCaps) as Record<string, ModelCapsOverride>
  } catch {
    return {}
  }
}

/** 某服务商下某个模型的实际能力（用户设定优先，否则按名称判断） */
export function capsFor(providerId: string | null | undefined, model: string): ModelCaps {
  let overrides: Record<string, ModelCapsOverride> = {}
  let kind: ProviderKind = 'custom'
  if (providerId) {
    try {
      const row = getProviderRow(providerId)
      overrides = parseCaps(row)
      kind = row.kind as ProviderKind
    } catch {
      /* 服务商已删除：按名称判断 */
    }
  }
  return resolveCaps(model, overrides, kind)
}

function toInfo(r: Row): ProviderInfo {
  const key = decryptKey(r)
  return {
    id: r.id,
    kind: r.kind as ProviderKind,
    name: r.name,
    baseUrl: r.baseUrl,
    hasKey: !!key,
    needsKey: !!r.apiKeyEnc && !key,
    keyHint: key ? `••••${key.slice(-4)}` : null,
    models: JSON.parse(r.models) as string[],
    modelCaps: parseCaps(r),
    sendEffort: r.sendEffort,
    enabled: r.enabled
  }
}

export function listProviders(): ProviderInfo[] {
  return getDb().select().from(providers).where(isNull(providers.deletedAt)).orderBy(asc(providers.createdAt)).all().map(toInfo)
}

export function getProviderRow(id: string): Row {
  const r = getDb()
    .select()
    .from(providers)
    .where(and(eq(providers.id, id), isNull(providers.deletedAt)))
    .get()
  if (!r) throw new Error('Provider not found')
  return r
}

export function saveProvider(input: ProviderInput): ProviderInfo {
  const db = getDb()
  const now = Date.now()
  const preset = PROVIDER_PRESETS[input.kind]
  // 更新时只改传入的字段：只改模型能力 / 价格时不能把名称和接口地址重置为预设值
  const patch: Partial<Row> = { kind: input.kind, updatedAt: now, updatedBy: deviceId() }
  if (!input.id || input.baseUrl !== undefined) {
    const baseUrl = (input.baseUrl ?? preset.baseURL).trim().replace(/\/+$/, '')
    // 新建“自定义”时预设地址为空，先建卡片再让用户填写；用户提交的地址必须合法
    const blankNew = !input.id && input.baseUrl === undefined && !baseUrl
    if (!blankNew && !/^https?:\/\//.test(baseUrl)) throw new Error('请填写以 http:// 或 https:// 开头的接口地址')
    patch.baseUrl = baseUrl
  }
  if (!input.id || input.name !== undefined) patch.name = input.name?.trim() || preset.name
  if (input.apiKey !== undefined) patch.apiKeyEnc = input.apiKey ? encrypt(input.apiKey.trim()) : null
  if (input.models) patch.models = JSON.stringify([...new Set(input.models.map((m) => m.trim()).filter(Boolean))])
  if (input.sendEffort !== undefined) patch.sendEffort = input.sendEffort
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.modelCaps) {
    // IPC 只接收手动项；自动报告/学习由主进程维护，恢复自动不能把它们一起清掉。
    const stored = input.id ? parseCaps(getProviderRow(input.id)) : {}
    const merged: Record<string, ModelCapsOverride> = {}
    for (const m of new Set([...Object.keys(stored), ...Object.keys(input.modelCaps)])) {
      const c = input.modelCaps[m]
      merged[m] = { ...c, reportedContext: stored[m]?.reportedContext, learnedContext: stored[m]?.learnedContext }
    }
    const clean = Object.fromEntries(
      Object.entries(merged)
        .map(([m, c]) => [m, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))] as const)
        .filter(([, c]) => Object.keys(c).length > 0)
    )
    patch.modelCaps = JSON.stringify(clean)
  }
  if (input.id) {
    const previous = getProviderRow(input.id)
    if (previous.kind !== input.kind || (patch.baseUrl !== undefined && previous.baseUrl !== patch.baseUrl)) {
      const caps = JSON.parse(patch.modelCaps ?? previous.modelCaps) as Record<string, ModelCapsOverride>
      for (const c of Object.values(caps)) {
        delete c.reportedContext
        delete c.learnedContext
      }
      patch.modelCaps = JSON.stringify(caps)
    }
  }
  if (input.id) {
    db.update(providers).set(patch).where(eq(providers.id, input.id)).run()
    return toInfo(getProviderRow(input.id))
  }
  const id = newId()
  db.insert(providers)
    .values({
      ...patch,
      id,
      kind: input.kind,
      name: patch.name!,
      baseUrl: patch.baseUrl!,
      models: patch.models ?? JSON.stringify(preset.models),
      createdAt: now,
      updatedAt: now
    } as Row)
    .run()
  return toInfo(getProviderRow(id))
}

export function removeProvider(id: string): void {
  getDb().update(providers).set({ deletedAt: Date.now(), apiKeyEnc: null, updatedAt: Date.now() }).where(eq(providers.id, id)).run()
}

function headers(row: Row): Record<string, string> {
  const key = decryptKey(row)
  if (!key) return {}
  if (row.kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  if (row.kind === 'google') return { 'x-goog-api-key': key }
  return { Authorization: `Bearer ${key}` }
}

type RemoteModel = Record<string, unknown>
function modelRecords(body: unknown): { id: string; context?: number }[] {
  if (!body || typeof body !== 'object') return []
  const b = body as { data?: unknown; models?: unknown }
  const items = Array.isArray(b.data) ? b.data : Array.isArray(b.models) ? b.models : []
  return items.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const m = item as RemoteModel
    const rawId = typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : ''
    if (!rawId) return []
    const context = ['context_length', 'context_window', 'max_context_length', 'inputTokenLimit', 'max_input_tokens']
      .map((key) => m[key])
      .find(validContext)
    return [{ id: rawId.replace(/^models\//, ''), ...(context ? { context } : {}) }]
  })
}

function storeAutomaticContext(id: string, model: string, field: 'reportedContext' | 'learnedContext', limit: number): boolean {
  if (!validContext(limit)) return false
  // 网络等待后重新读取，不能覆盖期间用户修改的能力。
  const row = getProviderRow(id),
    caps = parseCaps(row)
  const next = { ...caps[model], [field]: limit }
  if (field === 'learnedContext' && (next.reportedContext ?? 0) > limit) delete next.reportedContext
  if (JSON.stringify(caps[model]) === JSON.stringify(next)) return false
  caps[model] = next
  getDb()
    .update(providers)
    .set({ modelCaps: JSON.stringify(caps), updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(providers.id, id))
    .run()
  return true
}

export function learnContextLimit(id: string, model: string, limit: number): void {
  if (storeAutomaticContext(id, model, 'learnedContext', limit)) emit('providers:changed')
}

async function discoverContexts(row: Row, records: { id: string; context?: number }[]): Promise<void> {
  const base = row.baseUrl
  const results = [...records]
  if (row.kind === 'ollama') {
    // /v1 是兼容接口，/api/show 是 Ollama 原生配置；num_ctx 才是实际运行窗口。
    for (let start = 0; start < results.length; start += 4)
      await Promise.all(
        results.slice(start, start + 4).map(async (m) => {
          try {
            const response = await net.fetch(`${base.replace(/\/v1\/?$/, '')}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers(row) },
              body: JSON.stringify({ model: m.id }),
              signal: AbortSignal.timeout(5000)
            })
            if (!response.ok) return
            const body = (await response.json()) as { parameters?: string | { num_ctx?: number }; num_ctx?: number }
            const n =
              typeof body.parameters === 'string'
                ? Number(body.parameters.match(/(?:^|\n)\s*num_ctx\s+([\d]+)/)?.[1])
                : (body.parameters?.num_ctx ?? body.num_ctx)
            if (validContext(n)) m.context = n
          } catch {
            /* 旧服务可能没有 show，仍可正常使用默认预算 */
          }
        })
      )
  }
  const current = getProviderRow(row.id)
  if (current.baseUrl !== base || current.kind !== row.kind) return
  let changed = false
  for (const m of results) if (m.context) changed = storeAutomaticContext(row.id, m.id, 'reportedContext', m.context) || changed
  if (changed) emit('providers:changed')
}

/** 拉取服务商的模型列表（OpenAI 兼容 / Anthropic / Gemini 三种格式） */
export async function fetchModels(id: string): Promise<string[]> {
  const row = getProviderRow(id)
  if (!row.baseUrl) throw new Error('请先填写接口地址')
  const res = await net.fetch(`${row.baseUrl}/models`, { headers: headers(row), signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const records = modelRecords(await res.json())
  const list = records.map((m) => m.id)
  const models = list.filter((m) => !/embed|whisper|tts|dall-e|moderation|audio|image|realtime/i.test(m)).sort()
  saveProvider({ id, kind: row.kind as ProviderKind, models })
  await discoverContexts(
    row,
    records.filter((m) => models.includes(m.id))
  )
  return models
}

/** 连接测试：用最短的请求验证地址与密钥（不消耗或极少消耗 token） */
export async function testProvider(id: string): Promise<ProviderTestResult> {
  const row = getProviderRow(id)
  const t0 = Date.now()
  if (!row.baseUrl) return { ok: false, latencyMs: 0, message: '请先填写接口地址' }
  try {
    const res = await net.fetch(`${row.baseUrl}/models`, { headers: headers(row), signal: AbortSignal.timeout(15_000) })
    if (res.status === 401 || res.status === 403) return { ok: false, latencyMs: Date.now() - t0, message: 'API Key 无效或没有权限' }
    if (!res.ok) return { ok: false, latencyMs: Date.now() - t0, message: `HTTP ${res.status}` }
    const body = await res.json().catch(() => null)
    await discoverContexts(row, modelRecords(body))
    return { ok: true, latencyMs: Date.now() - t0, message: null }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 仅开发 / 测试：从另一个知识库复制服务商配置（API Key 保持加密形态，不解密、不输出），
 * 让端到端测试在临时数据目录中使用用户在应用里填写的服务商。安装版中不可用。
 */
export function importProvidersForTest(dbPath: string): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const src = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = src.prepare('SELECT * FROM providers WHERE deleted_at IS NULL').all() as Record<string, unknown>[]
    const ai = src.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string } | undefined
    const db = getDb()
    for (const r of rows) {
      db.insert(providers)
        .values({
          id: r.id as string,
          kind: r.kind as string,
          name: r.name as string,
          baseUrl: r.base_url as string,
          apiKeyEnc: r.api_key_enc as Buffer | null,
          models: r.models as string,
          modelCaps: (r.model_caps as string | undefined) ?? '{}',
          sendEffort: !!r.send_effort,
          enabled: !!r.enabled,
          createdAt: r.created_at as number,
          updatedAt: r.updated_at as number
        })
        .onConflictDoNothing()
        .run()
    }
    if (ai) getSqlite().prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('ai', ?)").run(ai.value)
    return rows.length
  } finally {
    src.close()
  }
}
