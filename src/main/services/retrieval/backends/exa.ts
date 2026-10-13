import { jsonResponse, normalizeResults, request, requiredKey, rows, type SearchBackend } from './common'
const days = { day: 1, week: 7, month: 30, year: 365 } as const
export const exa: SearchBackend = {
  id: 'exa',
  async search(query, cred, signal) {
    const response = await request('exa', 'https://api.exa.ai/search', signal, {
      method: 'POST',
      headers: { 'x-api-key': requiredKey(cred.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query.q,
        numResults: query.count,
        type: 'auto',
        contents: { text: { maxCharacters: 4000 }, highlights: true },
        ...(query.freshness ? { startPublishedDate: new Date(Date.now() - days[query.freshness] * 86400000).toISOString() } : {}),
        ...(query.site ? { includeDomains: [query.site] } : {})
      })
    })
    return normalizeResults(
      'exa',
      rows(jsonResponse(response).results).map((row) => {
        const highlights = Array.isArray(row.highlights)
          ? row.highlights.filter((v): v is string => typeof v === 'string' && !!v.trim()).join(' … ')
          : ''
        return { url: row.url, title: row.title, snippet: highlights || row.text, content: row.text, published: row.publishedDate }
      }),
      query.count
    )
  }
}
