import { net, safeStorage } from 'electron'
import { and, asc, eq, isNull } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb, getSqlite } from '../../db'
import { providers } from '../../db/schema'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { PROVIDER_PRESETS, resolveCaps, type ModelCaps, type ModelCapsOverride, type ProviderKind } from '@shared/ai'
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
  if (providerId) {
    try {
      overrides = parseCaps(getProviderRow(providerId))
    } catch {
      /* 服务商已删除：按名称判断 */
    }
  }
  return resolveCaps(model, overrides)
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
    // 只保留真正设定了的项（空对象等于“自动”）
    const clean = Object.fromEntries(
      Object.entries(input.modelCaps)
        .map(([m, c]) => [m, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))] as const)
        .filter(([, c]) => Object.keys(c).length > 0)
    )
    patch.modelCaps = JSON.stringify(clean)
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

/** 拉取服务商的模型列表（OpenAI 兼容 / Anthropic / Gemini 三种格式） */
export async function fetchModels(id: string): Promise<string[]> {
  const row = getProviderRow(id)
  if (!row.baseUrl) throw new Error('请先填写接口地址')
  const res = await net.fetch(`${row.baseUrl}/models`, { headers: headers(row), signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] }
  const list = body.data?.map((m) => m.id) ?? body.models?.map((m) => m.name.replace(/^models\//, '')) ?? []
  const models = list.filter((m) => !/embed|whisper|tts|dall-e|moderation|audio|image|realtime/i.test(m)).sort()
  saveProvider({ id, kind: row.kind as ProviderKind, models })
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
