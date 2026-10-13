import { jsonResponse, normalizeResults, optionalRecord, record, request, requiredKey, rows, withSite, type SearchBackend } from './common'
export const brave: SearchBackend = {
  id: 'brave',
  async search(query, cred, signal) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', withSite(query))
    url.searchParams.set('count', String(query.count))
    url.searchParams.set('result_filter', 'web')
    if (query.freshness) url.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[query.freshness])
    const response = await request('brave', url.href, signal, {
      method: 'GET',
      headers: { 'X-Subscription-Token': requiredKey(cred.key), Accept: 'application/json' }
    })
    return normalizeResults(
      'brave',
      rows(record(jsonResponse(response).web).results).map((row) => ({
        url: row.url,
        title: row.title,
        snippet: row.description,
        published: row.page_age,
        site: optionalRecord(row.profile).name
      })),
      query.count
    )
  }
}
