import { jsonResponse, normalizeResults, request, requiredKey, rows, withSite, type SearchBackend } from './common'
export const serper: SearchBackend = {
  id: 'serper',
  async search(query, cred, signal) {
    const news = query.type === 'news'
    const response = await request('serper', 'https://google.serper.dev/' + (news ? 'news' : 'search'), signal, {
      method: 'POST',
      fixtureSuffix: news ? '/news' : '',
      headers: { 'X-API-KEY': requiredKey(cred.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: withSite(query),
        num: query.count,
        hl: query.lang === 'zh' ? 'zh-cn' : 'en',
        ...(query.freshness ? { tbs: { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }[query.freshness] } : {})
      })
    })
    return normalizeResults(
      'serper',
      rows(jsonResponse(response)[news ? 'news' : 'organic']).map((row) => ({
        url: row.link,
        title: row.title,
        snippet: row.snippet,
        published: row.date,
        site: row.source
      })),
      query.count
    )
  }
}
