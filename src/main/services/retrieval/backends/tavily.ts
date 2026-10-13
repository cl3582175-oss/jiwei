import { jsonResponse, normalizeResults, request, requiredKey, rows, type SearchBackend } from './common'
export const tavily: SearchBackend = {
  id: 'tavily',
  async search(query, cred, signal) {
    const response = await request('tavily', 'https://api.tavily.com/search', signal, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + requiredKey(cred.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query.q,
        max_results: query.count,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        // P0 官方文档核对：general 模式默认不带日期，需显式请求。
        include_published_date: true,
        topic: query.type === 'news' ? 'news' : 'general',
        ...(query.freshness ? { time_range: query.freshness } : {}),
        ...(query.site ? { include_domains: [query.site] } : {})
      })
    })
    return normalizeResults(
      'tavily',
      rows(jsonResponse(response).results).map((row) => ({
        url: row.url,
        title: row.title,
        snippet: row.content,
        published: row.published_date
      })),
      query.count
    )
  }
}
