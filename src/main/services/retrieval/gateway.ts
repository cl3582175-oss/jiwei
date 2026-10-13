import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  ACADEMIC_BACKENDS,
  BACKEND_INFO,
  type BackendId,
  type BackendState,
  type Freshness,
  type RetrievalStatus,
  type SearchType,
  type WebResult
} from '@shared/retrieval'
import { getDb } from '../../db'
import { searchBackends, webSearchCache } from '../../db/schema'
import { emit, onMainEvent } from '../../events'
import { isSensitiveUrl } from '../../lib/browserPolicy'
import { tr } from '../../lib/messages'
import { checkBudget } from '../agent/usage'
import { withRun } from '../agent/context'
import { getSettings } from '../settings'
import { assertWebAllowed } from './policy'
import * as privacyGuard from './privacyGuard'
import { BACKENDS, BackendError, type BackendQuery } from './backends/index'
import { backendStates, credentialsFor } from './backends/store'
import { urlKey } from './backends/normalize'
import { DailyLimitError, recordCall, reserveCall, todayCalls } from './calls'

export interface SearchWebOptions {
  type?: 'web' | 'news'
  freshness?: Freshness
  site?: string
  count?: number
  signal?: AbortSignal
  guard?: () => void
  incognito?: boolean
  /** 仅旧 discover/search 的显式 service 兼容；仍经过全部请求守卫。 */
  legacyService?: 'bocha' | 'tavily' | 'brave'
}
const failures = new Map<BackendId, number>()
const pauses = new Map<BackendId, number>()
const available = (s: BackendState): boolean =>
  s.enabled && (!s.needsKey || s.keySet) && (s.id !== 'searxng' || !!s.baseUrl) && !s.pausedUntil
const language = (q: string): 'zh' | 'en' =>
  (q.match(/\p{Script=Han}/gu)?.length ?? 0) / (Array.from(q.replace(/\s/g, '')).length || 1) >= 0.3 ? 'zh' : 'en'
const limitCount = (count: number | undefined, fallback: number): number =>
  Math.min(10, Math.max(1, Math.floor(Number.isFinite(count) ? count! : fallback)))

function cleanQuery(q: string, guard?: () => void): string {
  guard?.()
  checkBudget()
  const clean = q.trim().replace(/\s+/g, ' ').slice(0, 100)
  if (clean && !privacyGuard.check(clean)) throw new privacyGuard.PrivacyError()
  return clean
}
function failed(id: BackendId, error: unknown): void {
  const count = (failures.get(id) ?? 0) + 1
  failures.set(id, count)
  const until =
    error instanceof BackendError && [401, 403].includes(error.status ?? 0)
      ? Date.now() + 1_800_000
      : count >= 3
        ? Date.now() + 600_000
        : null
  if (until) {
    pauses.set(id, until)
    emit('retrieval:changed', {})
  }
}
function succeeded(id: BackendId): void {
  failures.delete(id)
  if (pauses.delete(id)) emit('retrieval:changed', {})
}
function cacheKey(id: BackendId, query: BackendQuery): string {
  return createHash('sha256')
    .update(JSON.stringify({ b: id, q: query.q, t: query.type, f: query.freshness ?? null, s: query.site ?? null, c: query.count }))
    .digest('hex')
}
function lifetime(type: SearchType, freshness?: Freshness): number {
  if (type === 'academic') return 30 * 86_400_000
  if (type === 'news' || freshness === 'day') return 3_600_000
  if (freshness === 'week') return 21_600_000
  if (freshness) return 86_400_000
  return 7 * 86_400_000
}

async function callBackend(
  id: BackendId,
  query: BackendQuery,
  opts: { signal?: AbortSignal; guard?: () => void; incognito?: boolean; noCache?: boolean }
): Promise<WebResult[]> {
  opts.signal?.throwIfAborted()
  // 每次回退与缓存读取都按当前权限重新检查，不能沿用入口时的排除集合。
  cleanQuery(query.q, opts.guard)
  const start = Date.now(),
    key = cacheKey(id, query),
    db = getDb()
  if (!opts.noCache) {
    const cached = db.select().from(webSearchCache).where(eq(webSearchCache.key, key)).get()
    if (cached && cached.expiresAt > start) {
      try {
        const results = JSON.parse(cached.results) as WebResult[]
        if (!Array.isArray(results)) throw new Error()
        recordCall(id, 'search', true, true, start)
        return results
      } catch {
        db.delete(webSearchCache).where(eq(webSearchCache.key, key)).run()
      }
    }
  }
  const release = reserveCall()
  const config = db.select().from(searchBackends).where(eq(searchBackends.id, id)).get()
  const privacyController = new AbortController()
  // externalFetch可能等待同域队列；现有取消信号在真正发送前检查，及时撤销排队中的查询。
  const stopPrivacyChecks = (['notes:changed', 'sources:changed'] as const).map((event) =>
    onMainEvent(event, () => {
      if (!privacyGuard.check(query.q)) privacyController.abort(new privacyGuard.PrivacyError())
    })
  )
  const signal = opts.signal ? AbortSignal.any([opts.signal, privacyController.signal]) : privacyController.signal
  let ok = false,
    responded = false
  try {
    const results = await BACKENDS[id].search(query, credentialsFor(id), signal)
    responded = true
    signal.throwIfAborted()
    cleanQuery(query.q, opts.guard)
    // 搜索过程中用户可能停用或更换凭证；旧请求的结果不再进入后续流程。
    const current = db.select().from(searchBackends).where(eq(searchBackends.id, id)).get()
    if (
      current?.updatedAt !== config?.updatedAt ||
      current?.enabled !== config?.enabled ||
      current?.keyProviderId !== config?.keyProviderId ||
      current?.baseUrl !== config?.baseUrl ||
      !!current?.keyEnc !== !!config?.keyEnc ||
      (current?.keyEnc && config?.keyEnc && !current.keyEnc.equals(config.keyEnc))
    )
      throw new BackendError({ retryable: false, kind: 'configuration' })
    ok = true
    succeeded(id)
    if (!opts.noCache && !opts.incognito && results.length)
      db.insert(webSearchCache)
        .values({
          key,
          backend: id,
          results: JSON.stringify(results),
          createdAt: start,
          expiresAt: start + lifetime(query.type, query.freshness)
        })
        .onConflictDoUpdate({
          target: webSearchCache.key,
          set: { results: JSON.stringify(results), createdAt: start, expiresAt: start + lifetime(query.type, query.freshness) }
        })
        .run()
    return results
  } catch (error) {
    // 隐私撤销不是服务故障，不回退、不熔断，也不附带可能含查询的transport原始错误。
    if (privacyController.signal.aborted) throw privacyController.signal.reason
    if (!opts.signal?.aborted && !responded) failed(id, error)
    throw error
  } finally {
    for (const stop of stopPrivacyChecks) stop()
    try {
      recordCall(id, 'search', ok, false, start)
    } finally {
      release()
    }
  }
}

function filtered(results: WebResult[], count: number): WebResult[] {
  const seen = new Set<string>(),
    blocked = getSettings().browser?.aiBlockedSites ?? []
  return results
    .filter((r) => {
      const key = urlKey(r.url)
      if (!key || seen.has(key) || isSensitiveUrl(r.url, blocked)) return false
      seen.add(key)
      return true
    })
    .slice(0, count)
    .map((r, i) => ({ ...r, rank: i + 1 }))
}
function routed(query: BackendQuery, legacyService?: SearchWebOptions['legacyService']): BackendId[] {
  const states = backendStates(pauses)
  if (legacyService) return states.some((s) => s.id === legacyService && s.keySet) ? [legacyService] : []
  const settings = getSettings().retrieval
  const order =
    query.lang === 'zh'
      ? [settings.preferZh, 'bocha', 'zhipu', 'searxng', 'tavily', 'serper', 'brave', 'exa']
      : [settings.preferEn, 'tavily', 'brave', 'exa', 'serper', 'searxng', 'bocha', 'zhipu']
  const ids = [...new Set(order.filter((id): id is BackendId => !!id))].filter((id) => states.some((s) => s.id === id && available(s)))
  return ids.sort(
    (a, b) =>
      (query.site ? Number(!BACKEND_INFO[a].site) - Number(!BACKEND_INFO[b].site) : 0) ||
      (query.freshness || query.type === 'news' ? Number(!BACKEND_INFO[a].freshness) - Number(!BACKEND_INFO[b].freshness) : 0)
  )
}
const searchFailed = (): Error =>
  new Error(
    tr(
      '联网搜索暂时失败，请稍后再试或检查设置中的搜索服务',
      'Web search failed temporarily. Try again later or check the search services in settings.'
    )
  )

export async function searchWeb(q: string, opts: SearchWebOptions = {}): Promise<{ results: WebResult[]; backend: BackendId | null }> {
  assertWebAllowed()
  const query = cleanQuery(q, opts.guard)
  if (!query) return { results: [], backend: null }
  const input: BackendQuery = {
    q: query,
    type: opts.type ?? 'web',
    freshness: opts.freshness,
    site: opts.site,
    count: limitCount(opts.count, 8),
    lang: language(query)
  }
  const ids = routed(input, opts.legacyService)
  let empty: BackendId | null = null
  for (const id of ids) {
    try {
      const results = filtered(await callBackend(id, input, opts), input.count)
      if (results.length) return { results, backend: id }
      empty = id
    } catch (error) {
      // 原始取消原因可能含服务 URL/查询；不挂入 cause，避免跨 IPC 或日志泄漏。
      // eslint-disable-next-line preserve-caught-error
      if (opts.signal?.aborted) throw new Error(tr('搜索已取消', 'Search canceled'))
      opts.guard?.()
      if (error instanceof DailyLimitError || error instanceof privacyGuard.PrivacyError) throw error
    }
  }
  // 空响应不属于故障：尝试回退后仍为空时给模型机会换词。
  if (empty || !ids.length) return { results: [], backend: empty }
  throw searchFailed()
}

function mergeAcademic(groups: WebResult[][], count: number): WebResult[] {
  const candidates: { item: WebResult; score: number; aliases: Set<string> }[] = []
  const fields = (r: WebResult): number =>
    Number(!!r.pdfUrl) * 2 + Number(r.citations != null) * 2 + Number(!!r.authors?.length) + Number(!!r.doi) + Number(!!r.venue)
  for (const r of groups.flat()) {
    const aliases = [
      urlKey(r.url),
      r.doi ? `doi:${r.doi.toLowerCase()}` : null,
      `title:${r.title.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')}`
    ].filter((a): a is string => !!a && a !== 'title:')
    const matches = candidates.filter((c) => aliases.some((a) => c.aliases.has(a)))
    if (!matches.length) {
      candidates.push({ item: r, score: 1 / (60 + r.rank), aliases: new Set(aliases) })
      continue
    }
    const first = matches[0]
    first.score += 1 / (60 + r.rank)
    if (fields(r) > fields(first.item)) first.item = { ...first.item, ...r }
    else first.item = { ...r, ...first.item }
    aliases.forEach((a) => first.aliases.add(a))
    for (const other of matches.slice(1)) {
      first.score += other.score
      other.aliases.forEach((a) => first.aliases.add(a))
      if (fields(other.item) > fields(first.item)) first.item = { ...first.item, ...other.item }
      candidates.splice(candidates.indexOf(other), 1)
    }
  }
  return filtered(
    candidates.sort((a, b) => b.score - a.score).map((c) => c.item),
    count
  )
}

export async function searchAcademic(
  q: string,
  opts: { count?: number; signal?: AbortSignal; incognito?: boolean } = {}
): Promise<{ results: WebResult[]; backends: BackendId[] }> {
  assertWebAllowed()
  const query = cleanQuery(q)
  if (!query || !getSettings().retrieval.academic) return { results: [], backends: [] }
  const input: BackendQuery = { q: query, type: 'academic', count: limitCount(opts.count, 5), lang: language(query) }
  const ids = ACADEMIC_BACKENDS.filter(
    (id) => (id !== 'arxiv' || input.lang === 'en') && backendStates(pauses).some((s) => s.id === id && available(s))
  )
  const responses = await Promise.allSettled(ids.map((id) => callBackend(id, input, opts)))
  if (opts.signal?.aborted) throw new Error(tr('搜索已取消', 'Search canceled'))
  const denied = responses.find((response) => response.status === 'rejected' && response.reason instanceof privacyGuard.PrivacyError)
  if (denied?.status === 'rejected') throw denied.reason
  const groups: WebResult[][] = [],
    backends: BackendId[] = []
  responses.forEach((response, i) => {
    if (response.status === 'fulfilled') {
      groups.push(response.value)
      backends.push(ids[i])
    }
  })
  if (!groups.length && ids.length) {
    const limit = responses.find((r) => r.status === 'rejected' && r.reason instanceof DailyLimitError)
    if (limit?.status === 'rejected') throw limit.reason
    throw searchFailed()
  }
  return { results: mergeAcademic(groups, input.count), backends }
}

export function hasWebBackend(): boolean {
  return backendStates(pauses).some((s) => s.kind === 'web' && available(s))
}
export function retrievalStatus(): RetrievalStatus {
  return {
    backends: backendStates(pauses),
    webAvailable: hasWebBackend(),
    academicEnabled: getSettings().retrieval.academic,
    today: { calls: todayCalls(), limit: getSettings().retrieval.dailyLimit }
  }
}

export async function testBackend(id: BackendId): Promise<{ ok: boolean; message: string }> {
  return withRun({ purpose: 'search.test', caller: 'app' }, async () => {
    try {
      assertWebAllowed()
      const academic = (ACADEMIC_BACKENDS as readonly string[]).includes(id)
      const q = cleanQuery(academic ? 'machine learning' : 'learning')
      await callBackend(id, { q, type: academic ? 'academic' : 'web', count: 1, lang: 'en' }, { noCache: true })
      return { ok: true, message: tr('连接成功', 'Connection succeeded') }
    } catch {
      return { ok: false, message: tr('连接失败，请检查 Key 与网络', 'Connection failed; check the key and network') }
    }
  })
}
