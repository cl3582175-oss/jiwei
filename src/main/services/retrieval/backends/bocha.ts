import { jsonResponse, normalizeResults, recency, record, request, requiredKey, rows, type SearchBackend } from './common'
export const bocha: SearchBackend = {
  id: 'bocha',
  async search(query, cred, signal) {
    const response = await request('bocha', 'https://api.bochaai.com/v1/web-search', signal, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + requiredKey(cred.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query.q,
        summary: true,
        count: query.count,
        freshness: query.freshness ? recency[query.freshness] : 'noLimit'
      })
    })
    const data = jsonResponse(response)
    return normalizeResults(
      'bocha',
      rows(record(record(data.data).webPages).value).map((row) => ({
        url: row.url,
        title: row.name ?? row.title,
        snippet: row.summary ?? row.snippet,
        published: row.datePublished,
        site: row.siteName
      })),
      query.count
    )
  }
}
