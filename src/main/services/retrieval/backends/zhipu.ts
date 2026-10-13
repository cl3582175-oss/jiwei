import {
  assertStatus,
  BackendError,
  normalizeResults,
  optionalRecord,
  parseJson,
  recency,
  request,
  requiredKey,
  rows,
  type JsonRecord,
  type SearchBackend
} from './common'
export const zhipu: SearchBackend = {
  id: 'zhipu',
  async search(query, cred, signal) {
    const response = await request('zhipu', 'https://open.bigmodel.cn/api/paas/v4/web_search', signal, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + requiredKey(cred.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search_query: query.q.slice(0, 70),
        search_engine: 'search_std',
        search_intent: false,
        count: query.count,
        search_recency_filter: query.freshness ? recency[query.freshness] : 'noLimit',
        content_size: 'medium',
        ...(query.site ? { search_domain_filter: query.site } : {})
      })
    })
    // 鉴权错误不因响应里的业务码变成可重试；1701 也可能在 HTTP 400 中返回。
    if (response.status === 401 || response.status === 403) assertStatus(response)
    let data: JsonRecord
    try {
      data = parseJson(response.text)
    } catch (error) {
      assertStatus(response)
      throw error
    }
    const code = optionalRecord(data.error).code
    if (code === 1701 || code === '1701')
      throw new BackendError({ kind: 'service', retryable: true, ...(response.status === 200 ? {} : { status: response.status }) })
    assertStatus(response)
    if (code !== undefined) throw new BackendError({ kind: 'service', retryable: false })
    return normalizeResults(
      'zhipu',
      rows(data.search_result).map((row) => ({
        url: row.link,
        title: row.title,
        snippet: row.content,
        content: row.content,
        site: row.media,
        published: row.publish_date
      })),
      query.count
    )
  }
}
