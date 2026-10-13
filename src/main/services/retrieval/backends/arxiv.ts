import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser'
import { arxivPdf, parseFeed } from '../../../lib/feedParser'
import { assertStatus, BackendError, normalizeResults, record, request, rows, type ResultFields, type SearchBackend } from './common'
const atomNamespace = 'http://www.w3.org/2005/Atom'
function arxivUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!/^(www\.)?arxiv\.org$/.test(url.hostname) || !url.pathname.startsWith('/abs/')) return null
    const id = url.pathname.slice(5).replace(/v\d+$/, '')
    return id ? 'https://arxiv.org/abs/' + id : null
  } catch {
    return null
  }
}
export const arxiv: SearchBackend = {
  id: 'arxiv',
  async search(query, _cred, signal) {
    const url = new URL('https://export.arxiv.org/api/query')
    url.searchParams.set('search_query', 'all:' + query.q)
    url.searchParams.set('start', '0')
    url.searchParams.set('max_results', String(query.count))
    url.searchParams.set('sortBy', 'relevance')
    const response = await request('arxiv', url.href, signal, { method: 'GET', minIntervalMs: 3000 })
    assertStatus(response)
    try {
      if (/<!DOCTYPE|<!ENTITY/i.test(response.text) || XMLValidator.validate(response.text) !== true) throw new Error()
      // removeNSPrefix 会移除 xmlns 声明，先在保留命名空间的结构上验证 Atom。
      const document = record(new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(response.text))
      const root = Object.keys(document).find((key) => /^(?:[\w.-]+:)?feed$/.test(key))
      if (!root) throw new Error()
      const prefix = root.includes(':') ? ':' + root.split(':')[0] : ''
      if (record(document[root])['@_xmlns' + prefix] !== atomNamespace) throw new Error()
      const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true }).parse(
        response.text
      )
      const feed = record(record(parsed).feed)
      const entries = feed.entry === undefined ? [] : rows(Array.isArray(feed.entry) ? feed.entry : [feed.entry])
      const builder = new XMLBuilder({ ignoreAttributes: false })
      const values: ResultFields[] = []
      // parseFeed 会按日期排序且截到 30 条；逐 entry 复用它，保留 API 的 relevance 顺序。
      for (const entry of entries) {
        const single = builder.build({ feed: { '@_xmlns': atomNamespace, entry } })
        const item = parseFeed(single, 'https://arxiv.org/').items[0]
        if (!item) continue
        const canonical = arxivUrl(item.url)
        if (!canonical) continue
        values.push({
          url: canonical,
          title: entry.title,
          snippet: item.summary,
          ...(item.publishedAt === null ? {} : { published: new Date(item.publishedAt).toISOString() }),
          authors: item.author ? [item.author] : undefined,
          pdfUrl: arxivPdf(canonical)
        })
      }
      return normalizeResults('arxiv', values, query.count)
    } catch (error) {
      if (error instanceof BackendError) throw error
      throw new BackendError({ kind: 'parse', retryable: false })
    }
  }
}
