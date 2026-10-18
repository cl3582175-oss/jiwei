import { BackendError, jsonResponse, normalizeResults, request, requiredKey, rows, type SearchBackend } from './common'

const days = { day: 1, week: 7, month: 30, year: 365 } as const

export const deepseek: SearchBackend = {
  id: 'deepseek',
  async search(query, cred, signal) {
    const freshness = query.freshness ?? (query.type === 'news' ? 'week' : undefined)
    const filters = [
      ...(query.site ? ['site:' + query.site] : []),
      ...(freshness ? ['after:' + new Date(Date.now() - days[freshness] * 86_400_000).toISOString().slice(0, 10)] : [])
    ]
    const suffix = filters.length ? ' ' + filters.join(' ') : ''
    const room = 128 - Array.from(suffix).length
    const keywords = Array.from(query.q.trim()).slice(0, Math.max(0, room)).join('').trim()
    if (!keywords) throw new BackendError({ kind: 'configuration', retryable: false })
    const response = await request('deepseek', 'https://api.deepseek.com/v1/tools/search', signal, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + requiredKey(cred.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: keywords + suffix, count: query.count, need_content: false })
    })
    return normalizeResults(
      'deepseek',
      rows(jsonResponse(response).results).map((row) => ({
        url: row.url,
        title: row.title,
        snippet: row.snippet,
        summary: row.summary,
        published: row.date,
        site: row.site_name
      })),
      query.count
    )
  }
}
