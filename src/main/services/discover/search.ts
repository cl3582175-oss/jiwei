import { app } from 'electron'
import { eq } from 'drizzle-orm'
import { SearchSave, type SearchConnection, type SearchResult, type SearchService } from '@shared/discover'
import { getDb } from '../../db'
import { searchConnections } from '../../db/schema'
import { sealJson, openJson } from '../mcp/secrets'
import { externalFetch, checkedWebUrl } from '../externalFetch'
import { canonicalItemUrl, plainFeedText } from '../../lib/feedParser'
import { checkDiscoverUrl, discoverChanged } from './feeds'
import { tr } from '../../lib/messages'

export function searchProviders(): SearchConnection[] {
  const rows = getDb().select().from(searchConnections).all()
  return (['bocha', 'tavily', 'brave'] as const).map((service) => {
    const r = rows.find((r) => r.service === service)
    return { service, keySet: !!r?.keyEnc, enabled: !!r?.enabled }
  })
}
export function searchSave(input: Parameters<typeof SearchSave.parse>[0]): void {
  const v = SearchSave.parse(input),
    db = getDb(),
    old = db.select().from(searchConnections).where(eq(searchConnections.service, v.service)).get(),
    keyEnc = v.key === undefined ? (old?.keyEnc ?? null) : v.key.trim() ? sealJson(v.key.trim()) : null
  if (v.enabled && !keyEnc) throw new Error(tr('请填写搜索服务 Key', 'Enter a search service key'))
  db.transaction(() => {
    if (v.enabled) db.update(searchConnections).set({ enabled: false }).run()
    db.insert(searchConnections)
      .values({ service: v.service, keyEnc, enabled: v.enabled, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: searchConnections.service, set: { keyEnc, enabled: v.enabled, updatedAt: Date.now() } })
      .run()
  })
  discoverChanged()
}
export function hasSearch(): boolean {
  return searchProviders().some((p) => p.enabled && p.keySet)
}
const endpoints: Record<SearchService, string> = {
  bocha: 'https://api.bochaai.com/v1/web-search',
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search'
}
function endpoint(service: SearchService): string {
  const base = process.env.JIWEI_SEARCH_BASE
  if (!app.isPackaged && base) {
    const u = checkedWebUrl(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('Test search endpoint must be loopback')
    return `${u.href.replace(/\/$/, '')}/${service}`
  }
  return endpoints[service]
}
export async function search(
  query: string,
  options: {
    count?: number
    freshness?: 'day' | 'week' | 'month' | 'year'
    service?: SearchService
    signal?: AbortSignal
    guard?: () => void
  } = {}
): Promise<SearchResult[]> {
  const service = options.service ?? searchProviders().find((p) => p.enabled && p.keySet)?.service
  if (!service) return []
  const row = getDb().select().from(searchConnections).where(eq(searchConnections.service, service)).get()
  if (!row?.keyEnc || (!options.service && !row.enabled)) return []
  options.guard?.()
  const key = openJson<string>(row.keyEnc, ''),
    count = Math.min(10, Math.max(1, options.count ?? 8)),
    q = query.trim().slice(0, 500)
  if (!q) return []
  let url = endpoint(service),
    headers: Record<string, string>,
    body: string | undefined
  if (service === 'brave') {
    const u = new URL(url)
    u.searchParams.set('q', q)
    u.searchParams.set('count', String(count))
    u.searchParams.set('result_filter', 'web')
    if (options.freshness) u.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[options.freshness])
    url = u.href
    headers = { 'x-subscription-token': key, Accept: 'application/json' }
  } else {
    headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    body = JSON.stringify(
      service === 'bocha'
        ? {
            query: q,
            summary: true,
            count,
            freshness: options.freshness
              ? { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' }[options.freshness]
              : 'noLimit'
          }
        : {
            query: q,
            max_results: count,
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false,
            include_published_date: true,
            ...(options.freshness ? { time_range: options.freshness } : {})
          }
    )
  }
  try {
    const r = await externalFetch(url, {
      headers,
      body,
      method: body ? 'POST' : 'GET',
      signal: options.signal,
      httpsOnly: true,
      validateUrl: (next) => {
        if (new URL(next).origin !== new URL(url).origin) throw new Error('Search redirect refused')
        options.guard?.()
      }
    })
    options.guard?.()
    const current = getDb().select().from(searchConnections).where(eq(searchConnections.service, service)).get()
    if (!current?.keyEnc?.equals(row.keyEnc) || current.enabled !== row.enabled) throw new Error('Search settings changed')
    if (r.status !== 200) throw new Error('Search failed')
    const data = JSON.parse(r.text),
      results: Record<string, unknown>[] =
        service === 'bocha' ? (data.data?.webPages?.value ?? []) : service === 'brave' ? (data.web?.results ?? []) : (data.results ?? [])
    if (!Array.isArray(results)) throw new Error('Invalid search response')
    return results.slice(0, count).flatMap((i) => {
      const url = typeof i.url === 'string' ? canonicalItemUrl(i.url) : null
      if (!url) return []
      try {
        checkDiscoverUrl(url)
      } catch {
        return []
      }
      const at = Date.parse(String(i.published_date ?? i.datePublished ?? ''))
      return [
        {
          url,
          title: plainFeedText(i.title, 500) || url,
          snippet: plainFeedText(i.summary ?? i.content ?? i.description ?? i.snippet),
          ...(Number.isFinite(at) ? { publishedAt: at } : {})
        }
      ]
    })
  } catch {
    if (options.signal?.aborted) throw new Error('Search canceled')
    // 服务响应可能含密钥或用户查询，不把原始错误跨 IPC 或写入日志。
    options.guard?.()
    throw new Error(tr('搜索失败，请检查 Key、额度与网络', 'Search failed; check the key, credits and network'))
  }
}
export async function searchTest(service: SearchService): Promise<{ ok: boolean; message: string }> {
  try {
    await search('learning', { count: 1, service })
    return { ok: true, message: tr('搜索连接成功', 'Search connection succeeded') }
  } catch {
    return { ok: false, message: tr('搜索连接失败，请检查 Key 与网络', 'Search connection failed; check key and network') }
  }
}
