import { BackendError, jsonResponse, normalizeResults, request, rows, withSite, type SearchBackend } from './common'
import { validateSearxngUrl } from './store'
export const searxng: SearchBackend = {
  id: 'searxng',
  async search(query, cred, signal) {
    let base: string
    try {
      base = validateSearxngUrl(cred.baseUrl ?? '')
    } catch {
      throw new BackendError({ kind: 'configuration', retryable: false })
    }
    const url = new URL(base + '/search')
    url.searchParams.set('q', withSite(query))
    url.searchParams.set('format', 'json')
    url.searchParams.set('language', query.lang === 'zh' ? 'zh-CN' : 'en')
    url.searchParams.set('categories', query.type === 'news' ? 'news' : 'general')
    if (query.freshness) url.searchParams.set('time_range', query.freshness)
    const response = await request('searxng', url.href, signal, { method: 'GET', httpsOnly: false })
    return normalizeResults(
      'searxng',
      rows(jsonResponse(response).results).map((row) => {
        let host: string | undefined
        try {
          host = typeof row.url === 'string' ? new URL(row.url).hostname : undefined
        } catch {
          /* 非法地址由统一归一化丢弃。 */
        }
        return { url: row.url, title: row.title, snippet: row.content, published: row.publishedDate, site: host }
      }),
      query.count
    )
  }
}
