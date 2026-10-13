import { eq } from 'drizzle-orm'
import {
  ACADEMIC_BACKENDS,
  BACKEND_IDS,
  BACKEND_INFO,
  BackendSaveSchema,
  type BackendId,
  type BackendSave,
  type BackendState
} from '@shared/retrieval'
import { getDb } from '../../../db'
import { meta, searchBackends, searchConnections } from '../../../db/schema'
import { sealJson, openJson } from '../../mcp/secrets'
import { getProviderRow, decryptKey } from '../../ai/providers'
import { tr } from '../../../lib/messages'

type Row = typeof searchBackends.$inferSelect
const academic = (id: BackendId): boolean => (ACADEMIC_BACKENDS as readonly string[]).includes(id)

export function validateSearxngUrl(value: string): string {
  try {
    const u = new URL(value.trim())
    const host = u.hostname.toLowerCase()
    const octets = host.split('.').map(Number)
    const privateIp =
      octets.length === 4 &&
      octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168))
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.local') || privateIp
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.protocol === 'http:' && !local))
      throw new Error()
    return u.href.replace(/\/+$/, '')
  } catch {
    throw new Error(
      tr(
        '地址不正确：公网地址需要 https，且不能带用户名、密码或参数。',
        'Invalid address: public instances need HTTPS and must not include credentials, query parameters or a fragment.'
      )
    )
  }
}

/** 开机一次性迁移，整笔事务只搬运密文，永不覆盖已保存的新配置。 */
export function migrateSearchConnections(): void {
  const db = getDb()
  db.transaction(() => {
    if (db.select().from(meta).where(eq(meta.key, 'retrieval.migrated')).get()?.value === '1') return
    for (const row of db.select().from(searchConnections).all()) {
      if (!['bocha', 'tavily', 'brave'].includes(row.service)) continue
      db.insert(searchBackends)
        .values({ id: row.service, keyEnc: row.keyEnc, enabled: row.enabled, updatedAt: row.updatedAt })
        .onConflictDoNothing()
        .run()
    }
    db.insert(meta)
      .values({ key: 'retrieval.migrated', value: '1' })
      .onConflictDoUpdate({ target: meta.key, set: { value: '1' } })
      .run()
  })
}

function providerKey(id: string): string | null {
  try {
    const row = getProviderRow(id)
    return row.kind === 'zhipu' ? decryptKey(row) : null
  } catch {
    return null
  }
}

export function credentialsFor(id: BackendId): { key: string | null; baseUrl: string | null } {
  const row = getDb().select().from(searchBackends).where(eq(searchBackends.id, id)).get()
  return {
    key: id === 'zhipu' && row?.keyProviderId ? providerKey(row.keyProviderId) : openJson<string | null>(row?.keyEnc, null),
    baseUrl: row?.baseUrl ?? null
  }
}

export function backendStates(pauses: ReadonlyMap<BackendId, number> = new Map()): BackendState[] {
  const rows = getDb().select().from(searchBackends).all()
  return BACKEND_IDS.map((id) => {
    const row = rows.find((r) => r.id === id)
    return {
      id,
      kind: academic(id) ? 'academic' : 'web',
      keySet: id === 'zhipu' && row?.keyProviderId ? !!providerKey(row.keyProviderId) : !!row?.keyEnc,
      keyProviderId: id === 'zhipu' ? (row?.keyProviderId ?? null) : null,
      baseUrl: id === 'searxng' ? (row?.baseUrl ?? null) : null,
      // 学术库无需配置即可用；显式保存的 enabled 优先于默认值。
      enabled: row?.enabled ?? academic(id),
      needsKey: BACKEND_INFO[id].needsKey,
      pausedUntil: (pauses.get(id) ?? 0) > Date.now() ? pauses.get(id)! : null
    }
  })
}

export function saveBackend(input: BackendSave): void {
  const value = BackendSaveSchema.parse(input)
  const db = getDb()
  const old = db.select().from(searchBackends).where(eq(searchBackends.id, value.id)).get()
  const keyProviderId =
    value.id === 'zhipu' ? (value.keyProviderId === undefined ? (old?.keyProviderId ?? null) : value.keyProviderId) : null
  if (value.id !== 'zhipu' && value.keyProviderId != null)
    throw new Error(tr('只有智谱搜索可以使用模型服务的 Key', 'Only Zhipu search can reuse a model provider key'))
  if (keyProviderId) {
    try {
      if (getProviderRow(keyProviderId).kind !== 'zhipu') throw new Error()
    } catch {
      throw new Error(tr('请选择有效的智谱模型服务', 'Select an existing Zhipu model provider'))
    }
  }
  const keyEnc = keyProviderId
    ? null
    : value.key === undefined
      ? (old?.keyEnc ?? null)
      : value.key.trim()
        ? sealJson(value.key.trim())
        : null
  const baseUrl =
    value.id === 'searxng'
      ? value.baseUrl === undefined
        ? (old?.baseUrl ?? null)
        : value.baseUrl.trim()
          ? validateSearxngUrl(value.baseUrl)
          : null
      : null
  if (value.enabled && value.id === 'searxng' && !baseUrl) throw new Error(tr('请先填写实例地址', 'Enter an instance address first'))
  if (value.enabled && BACKEND_INFO[value.id].needsKey && !(keyProviderId ? providerKey(keyProviderId) : keyEnc))
    throw new Error(tr('请先填写 Key', 'Enter a key first'))
  const row: Row = { id: value.id, keyEnc, keyProviderId, baseUrl, enabled: value.enabled, updatedAt: Date.now() }
  db.insert(searchBackends).values(row).onConflictDoUpdate({ target: searchBackends.id, set: row }).run()
}
