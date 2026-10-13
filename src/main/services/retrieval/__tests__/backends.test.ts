import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKEND_IDS, type BackendId, type WebResult } from '@shared/retrieval'
import type { externalFetch } from '../../externalFetch'
import { BACKENDS, BackendError, type BackendQuery } from '../backends/index'

const context = vi.hoisted(() => ({ fetch: vi.fn<typeof externalFetch>(), packaged: false, blocked: [] as string[] }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return context.packaged
    },
    getLocale: () => 'en'
  },
  nativeTheme: {}
}))
vi.mock('../../externalFetch', async (original) => ({
  ...(await original<typeof import('../../externalFetch')>()),
  externalFetch: context.fetch
}))
vi.mock('../../settings', () => ({ getSettings: () => ({ browser: { aiBlockedSites: context.blocked } }) }))
vi.mock('../../../db', () => ({
  getDb: () => {
    throw new Error('Test database access forbidden')
  }
}))
vi.mock('../../ai/providers', () => ({ getProviderRow: vi.fn(), decryptKey: vi.fn() }))
vi.mock('../../mcp/secrets', () => ({ sealJson: vi.fn(), openJson: vi.fn() }))

const query: BackendQuery = { q: '联网 & retrieval', type: 'web', count: 2, lang: 'zh', freshness: 'week', site: 'example.org' }
const cred: { key: string | null; baseUrl: string | null } = { key: 'synthetic-test-key', baseUrl: 'http://127.0.0.1:8080/instance' }
const jsonIds = BACKEND_IDS.filter((id) => id !== 'arxiv')
const fixture = (id: string): string =>
  readFileSync(new URL('./fixtures/' + (id === 'arxiv' ? 'arxiv.xml' : id + '.json'), import.meta.url), 'utf8')
const respond = (text: string, status = 200): void => {
  context.fetch.mockResolvedValue({ status, text, bytes: new TextEncoder().encode(text), headers: new Headers() })
}
const call = (id: BackendId, input: Partial<BackendQuery> = {}, credentials = cred): Promise<WebResult[]> =>
  BACKENDS[id].search({ ...query, ...input }, credentials, new AbortController().signal)
const capture = () => {
  const [url, options] = context.fetch.mock.calls.at(-1)!
  return { url: new URL(url), options: options! }
}
type Row = Record<string, unknown>
const asRow = (v: unknown): Row => v as Row
function rowsOf(id: BackendId, raw: Row): Row[] {
  if (id === 'bocha') return asRow(asRow(raw.data).webPages).value as Row[]
  if (id === 'brave') return asRow(raw.web).results as Row[]
  return raw[id === 'zhipu' ? 'search_result' : id === 'serper' ? 'organic' : id === 'semanticscholar' ? 'data' : 'results'] as Row[]
}
function setRows(id: BackendId, rows: unknown[]): string {
  if (id === 'bocha') return JSON.stringify({ data: { webPages: { value: rows } } })
  if (id === 'brave') return JSON.stringify({ web: { results: rows } })
  return JSON.stringify({
    [id === 'zhipu' ? 'search_result' : id === 'serper' ? 'organic' : id === 'semanticscholar' ? 'data' : 'results']: rows
  })
}
function resultAt(id: BackendId, url: string, title: string): Row {
  const first = rowsOf(id, JSON.parse(fixture(id)))[0]
  if (id === 'openalex') return { ...first, display_name: title, doi: null, id: url, primary_location: { landing_page_url: url } }
  if (id === 'semanticscholar') return { ...first, title, externalIds: {}, url }
  return { ...first, title, name: title, url, link: url }
}
beforeEach(() => {
  context.fetch.mockReset()
  context.packaged = false
  context.blocked = []
  vi.stubEnv('JIWEI_SEARCH_BASE', '')
  vi.stubEnv('JIWEI_TEST_NETWORK', '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('backend request contracts', () => {
  it('registers ten implementations', () => {
    expect(Object.keys(BACKENDS)).toEqual([...BACKEND_IDS])
    for (const id of BACKEND_IDS) expect(BACKENDS[id].id).toBe(id)
  })
  const requests: {
    id: BackendId
    origin: string
    path: string
    method: string
    params?: Record<string, string>
    headers?: Record<string, string>
    body?: Row
  }[] = [
    {
      id: 'bocha',
      origin: 'https://api.bochaai.com',
      path: '/v1/web-search',
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-test-key' },
      body: { query: '联网 & retrieval', summary: true, count: 2, freshness: 'oneWeek' }
    },
    {
      id: 'zhipu',
      origin: 'https://open.bigmodel.cn',
      path: '/api/paas/v4/web_search',
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-test-key' },
      body: {
        search_query: '联网 & retrieval',
        search_engine: 'search_std',
        search_intent: false,
        count: 2,
        search_recency_filter: 'oneWeek',
        content_size: 'medium',
        search_domain_filter: 'example.org'
      }
    },
    {
      id: 'tavily',
      origin: 'https://api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-test-key' },
      body: {
        query: '联网 & retrieval',
        max_results: 2,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        include_published_date: true,
        topic: 'general',
        time_range: 'week',
        include_domains: ['example.org']
      }
    },
    {
      id: 'brave',
      origin: 'https://api.search.brave.com',
      path: '/res/v1/web/search',
      method: 'GET',
      params: { q: '联网 & retrieval site:example.org', count: '2', result_filter: 'web', freshness: 'pw' },
      headers: { 'X-Subscription-Token': 'synthetic-test-key', Accept: 'application/json' }
    },
    { id: 'exa', origin: 'https://api.exa.ai', path: '/search', method: 'POST', headers: { 'x-api-key': 'synthetic-test-key' } },
    {
      id: 'serper',
      origin: 'https://google.serper.dev',
      path: '/search',
      method: 'POST',
      headers: { 'X-API-KEY': 'synthetic-test-key' },
      body: { q: '联网 & retrieval site:example.org', num: 2, hl: 'zh-cn', tbs: 'qdr:w' }
    },
    {
      id: 'searxng',
      origin: 'http://127.0.0.1:8080',
      path: '/instance/search',
      method: 'GET',
      params: { q: '联网 & retrieval site:example.org', format: 'json', language: 'zh-CN', categories: 'general', time_range: 'week' }
    },
    {
      id: 'openalex',
      origin: 'https://api.openalex.org',
      path: '/works',
      method: 'GET',
      params: {
        search: '联网 & retrieval',
        per_page: '2',
        api_key: 'synthetic-test-key',
        select:
          'id,doi,display_name,publication_year,publication_date,authorships,primary_location,cited_by_count,abstract_inverted_index,open_access,best_oa_location'
      }
    },
    {
      id: 'semanticscholar',
      origin: 'https://api.semanticscholar.org',
      path: '/graph/v1/paper/search',
      method: 'GET',
      params: {
        query: '联网 & retrieval',
        limit: '2',
        fields: 'title,url,year,abstract,authors,venue,citationCount,externalIds,openAccessPdf,publicationDate'
      },
      headers: { 'x-api-key': 'synthetic-test-key' }
    },
    {
      id: 'arxiv',
      origin: 'https://export.arxiv.org',
      path: '/api/query',
      method: 'GET',
      params: { search_query: 'all:联网 & retrieval', start: '0', max_results: '2', sortBy: 'relevance' }
    }
  ]
  it.each(requests)('$id emits the documented request and redirect/signal protections', async (want) => {
    respond(fixture(want.id))
    await call(want.id)
    const { url, options } = capture()
    expect(url.origin).toBe(want.origin)
    expect(url.pathname).toBe(want.path)
    expect(options.method).toBe(want.method)
    if (want.params) expect(Object.fromEntries(url.searchParams)).toEqual(want.params)
    if (want.headers) expect(options.headers).toMatchObject(want.headers)
    if (want.body) expect(JSON.parse(options.body!)).toEqual(want.body)
    if (want.method === 'POST') expect(options.headers).toMatchObject({ 'Content-Type': 'application/json' })
    else expect(options.body).toBeUndefined()
    expect(Object.keys(options.headers ?? {}).map((key) => key.toLowerCase())).not.toContain('user-agent')
    expect(options.httpsOnly).toBe(want.id !== 'searxng')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(() => options.validateUrl!(url.href)).not.toThrow()
    expect(() => options.validateUrl!('https://unrelated.example.org/redirect')).toThrow(BackendError)
    expect(options).not.toHaveProperty('timeout')
  })
  it('Tavily requests dates for general and news without requesting generated answers', async () => {
    respond(fixture('tavily'))
    await call('tavily', { type: 'news', freshness: undefined, site: undefined })
    expect(JSON.parse(capture().options.body!)).toEqual({
      query: '联网 & retrieval',
      max_results: 2,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_published_date: true,
      topic: 'news'
    })
  })
  it('Zhipu truncates a query to 70 characters', async () => {
    respond(fixture('zhipu'))
    await call('zhipu', { q: '检'.repeat(90) })
    expect(JSON.parse(capture().options.body!).search_query).toBe('检'.repeat(70))
  })
  it.each([
    ['day', 'oneDay', 'pd', 'qdr:d'],
    ['week', 'oneWeek', 'pw', 'qdr:w'],
    ['month', 'oneMonth', 'pm', 'qdr:m'],
    ['year', 'oneYear', 'py', 'qdr:y']
  ] as const)('maps %s freshness', async (freshness, long, short, tbs) => {
    respond(fixture('bocha'))
    await call('bocha', { freshness })
    expect(JSON.parse(capture().options.body!).freshness).toBe(long)
    respond(fixture('zhipu'))
    await call('zhipu', { freshness })
    expect(JSON.parse(capture().options.body!).search_recency_filter).toBe(long)
    respond(fixture('brave'))
    await call('brave', { freshness })
    expect(capture().url.searchParams.get('freshness')).toBe(short)
    respond(fixture('serper'))
    await call('serper', { freshness })
    expect(JSON.parse(capture().options.body!).tbs).toBe(tbs)
  })
  it('omits optional filters and uses documented noLimit defaults', async () => {
    for (const id of ['bocha', 'zhipu', 'brave', 'serper', 'searxng'] as const) {
      respond(fixture(id))
      await call(id, { freshness: undefined, site: undefined, lang: 'en' })
      const { url, options } = capture()
      if (id === 'bocha') expect(JSON.parse(options.body!).freshness).toBe('noLimit')
      if (id === 'zhipu') {
        expect(JSON.parse(options.body!).search_recency_filter).toBe('noLimit')
        expect(JSON.parse(options.body!)).not.toHaveProperty('search_domain_filter')
      }
      if (id === 'brave') {
        expect(url.searchParams.get('q')).toBe('联网 & retrieval')
        expect(url.searchParams.has('freshness')).toBe(false)
      }
      if (id === 'serper') expect(JSON.parse(options.body!)).toEqual({ q: '联网 & retrieval', num: 2, hl: 'en' })
      if (id === 'searxng') {
        expect(url.searchParams.get('language')).toBe('en')
        expect(url.searchParams.has('time_range')).toBe(false)
      }
    }
  })
  it('Serper chooses news endpoint and SearXNG chooses news category', async () => {
    respond(fixture('serper-news'))
    const [r] = await call('serper', { type: 'news', lang: 'en' })
    expect(capture().url.pathname).toBe('/news')
    expect(JSON.parse(capture().options.body!).hl).toBe('en')
    expect(r).toMatchObject({ title: 'News fixture', snippet: 'News snippet', site: 'Fixture newsroom' })
    expect(r.publishedAt).toBeUndefined()
    respond(fixture('searxng'))
    await call('searxng', { type: 'news' })
    expect(capture().url.searchParams.get('categories')).toBe('news')
  })
  it.each([
    ['day', '2026-01-14T12:00:00.000Z'],
    ['week', '2026-01-08T12:00:00.000Z'],
    ['month', '2025-12-16T12:00:00.000Z'],
    ['year', '2025-01-15T12:00:00.000Z']
  ] as const)('Exa turns %s into ISO and requests bounded text/highlights', async (freshness, expected) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-15T12:00:00Z'))
    respond(fixture('exa'))
    const [r] = await call('exa', { freshness })
    expect(JSON.parse(capture().options.body!)).toEqual({
      query: '联网 & retrieval',
      numResults: 2,
      type: 'auto',
      contents: { text: { maxCharacters: 4000 }, highlights: true },
      startPublishedDate: expected,
      includeDomains: ['example.org']
    })
    expect(r).toMatchObject({ snippet: 'Fixture first … Fixture second', content: 'Fixture body', publishedAt: 1767323045000 })
  })
  it('Exa falls back to text without highlights and omits absent filters', async () => {
    const raw = JSON.parse(fixture('exa'))
    raw.results[0].highlights = []
    respond(JSON.stringify(raw))
    expect((await call('exa', { freshness: undefined, site: undefined }))[0].snippet).toBe('Fixture body')
    expect(JSON.parse(capture().options.body!)).toEqual({
      query: '联网 & retrieval',
      numResults: 2,
      type: 'auto',
      contents: { text: { maxCharacters: 4000 }, highlights: true }
    })
  })
  it('omits optional academic Keys and sets the no-Key Semantic Scholar interval', async () => {
    respond(fixture('openalex'))
    await call('openalex', {}, { key: null, baseUrl: null })
    expect(capture().url.searchParams.has('api_key')).toBe(false)
    respond(fixture('semanticscholar'))
    await call('semanticscholar', {}, { key: null, baseUrl: null })
    expect(capture().options.headers).not.toHaveProperty('x-api-key')
    expect(capture().options.minIntervalMs).toBe(1100)
    await call('semanticscholar')
    expect(capture().options.minIntervalMs).toBeUndefined()
  })
})

describe('backend result normalization', () => {
  it.each(['bocha', 'zhipu', 'tavily', 'brave', 'serper', 'searxng'] as const)('%s maps clean title/snippet/url/date', async (id) => {
    respond(fixture(id))
    const [r] = await call(id)
    expect(r).toMatchObject({
      backend: id,
      url: 'https://www.example.org/read?a=1&b=2',
      title: 'Fixture title',
      snippet: 'Fixture snippet',
      rank: 1,
      publishedAt: 1767323045000
    })
    if (['bocha', 'zhipu', 'brave', 'serper'].includes(id)) expect(r.site).toBe('Fixture site')
    if (id === 'searxng') expect(r.site).toBe('www.example.org')
    if (id === 'zhipu') expect(r.content).toBe('Fixture snippet')
  })
  it('Bocha accepts old title/snippet fields and ignores invalid dates', async () => {
    respond(fixture('bocha'))
    const rows = await call('bocha')
    expect(rows[1]).toMatchObject({ title: 'Fallback title', snippet: 'Fallback snippet', rank: 2 })
    expect(rows[1].publishedAt).toBeUndefined()
  })
  it.each(['openalex', 'semanticscholar'] as const)('%s maps DOI/authors/year/venue/citations/PDF and date', async (id) => {
    respond(fixture(id))
    expect((await call(id))[0]).toEqual({
      backend: id,
      rank: 1,
      url: 'https://doi.org/10.1234/fixture',
      title: 'Academic fixture',
      snippet: id === 'openalex' ? 'Index restored well' : 'Fixture abstract',
      publishedAt: 1767312000000,
      doi: '10.1234/fixture',
      authors: ['Ada', 'Bo', 'Chen', 'Dina', 'Eli', 'Farah'],
      year: 2026,
      venue: 'Fixture journal',
      citations: 7,
      pdfUrl: 'https://papers.example.org/full.pdf'
    })
  })
  it('OpenAlex does not label oa_url landing pages as PDFs and falls back to landing/id', async () => {
    const raw = JSON.parse(fixture('openalex'))
    raw.results[0].doi = null
    raw.results[0].best_oa_location = null
    raw.results[0].abstract_inverted_index = null
    respond(JSON.stringify(raw))
    const [r] = await call('openalex')
    expect(r.url).toBe('https://papers.example.org/landing')
    expect(r.snippet).toBe('')
    expect(r.pdfUrl).toBeUndefined()
    raw.results[0].primary_location = null
    respond(JSON.stringify(raw))
    expect((await call('openalex'))[0].url).toBe('https://openalex.org/W0000001')
  })
  it('OpenAlex restores sparse/repeated positions without unbounded sparse arrays', async () => {
    const raw = JSON.parse(fixture('openalex'))
    raw.results[0].abstract_inverted_index = { first: [0, 2], last: [1000000000], middle: [1] }
    respond(JSON.stringify(raw))
    expect((await call('openalex'))[0].snippet).toBe('first middle first last')
  })
  it('Semantic Scholar tolerates absent abstract/DOI/PDF metadata', async () => {
    const raw = JSON.parse(fixture('semanticscholar'))
    raw.data[0].externalIds = {}
    raw.data[0].abstract = null
    raw.data[0].openAccessPdf = null
    respond(JSON.stringify(raw))
    const [r] = await call('semanticscholar')
    expect(r.url).toBe('https://www.semanticscholar.org/paper/fixture')
    expect(r.snippet).toBe('')
    expect(r.pdfUrl).toBeUndefined()
  })
  it('arXiv keeps relevance order despite older publication date and normalizes versioned links', async () => {
    respond(fixture('arxiv'))
    expect(await call('arxiv')).toEqual([
      {
        backend: 'arxiv',
        rank: 1,
        url: 'https://arxiv.org/abs/2401.01234',
        title: 'First relevance result',
        snippet: 'First abstract',
        authors: ['Ada, Bo'],
        pdfUrl: 'https://arxiv.org/pdf/2401.01234',
        publishedAt: 1577934245000
      },
      {
        backend: 'arxiv',
        rank: 2,
        url: 'https://arxiv.org/abs/hep-th/0301234',
        title: 'Second relevance result',
        snippet: 'Second abstract',
        authors: ['Chen'],
        pdfUrl: 'https://arxiv.org/pdf/hep-th/0301234',
        publishedAt: 1767323045000
      }
    ])
    expect(capture().options.minIntervalMs).toBe(3000)
  })
  it('arXiv drops foreign links and blocked hosts while keeping rank continuous', async () => {
    respond(fixture('arxiv').replaceAll('arxiv.org/abs/2401.01234v2', 'foreign.example.org/abs/2401.01234v2'))
    expect((await call('arxiv')).map((r) => [r.url, r.rank])).toEqual([['https://arxiv.org/abs/hep-th/0301234', 1]])
    context.blocked = ['arxiv.org']
    respond(fixture('arxiv'))
    expect(await call('arxiv')).toEqual([])
  })
  it('arXiv accepts a namespace-prefixed Atom feed', async () => {
    const xml = fixture('arxiv')
      .replace('xmlns="http://www.w3.org/2005/Atom"', 'xmlns:atom="http://www.w3.org/2005/Atom"')
      .replace(/<(\/?)(feed|entry|id|title|summary|published|author|name|link)(?=[\s>])/g, '<$1atom:$2')
    respond(xml)
    expect((await call('arxiv')).map((r) => r.title)).toEqual(['First relevance result', 'Second relevance result'])
  })
  it.each(jsonIds)('%s filters invalid/sensitive/blocked URLs before count and continuous rank', async (id) => {
    context.blocked = ['blocked.example.org']
    respond(
      setRows(id, [
        resultAt(id, 'javascript:alert(1)', 'Invalid'),
        resultAt(id, 'https://mail.example.org/inbox', 'Sensitive'),
        resultAt(id, 'https://child.blocked.example.org/read', 'Blocked'),
        resultAt(id, 'https://good.example.org/one/?utm_x=1', ''),
        resultAt(id, 'https://good.example.org/two', 'Second'),
        resultAt(id, 'https://good.example.org/three', 'Third')
      ])
    )
    expect((await call(id)).map((r) => ({ url: r.url, title: r.title, rank: r.rank }))).toEqual([
      { url: 'https://good.example.org/one', title: 'good.example.org', rank: 1 },
      { url: 'https://good.example.org/two', title: 'Second', rank: 2 }
    ])
  })
  it('bounds title/snippet/content after stripping markup', async () => {
    const raw = JSON.parse(fixture('zhipu'))
    raw.search_result[0].title = '<b>' + 'T'.repeat(400) + '</b>'
    raw.search_result[0].content = '<p>' + 'S'.repeat(9000) + '</p><script>remove()</script>'
    respond(JSON.stringify(raw))
    const [r] = await call('zhipu')
    expect(r.title).toBe('T'.repeat(300))
    expect(r.snippet).toBe('S'.repeat(600))
    expect(r.content).toBe('S'.repeat(8000))
  })
  it.each(['openalex', 'semanticscholar'] as const)('%s drops unsafe PDF URLs', async (id) => {
    const raw = JSON.parse(fixture(id))
    if (id === 'openalex') raw.results[0].best_oa_location.pdf_url = 'https://mail.example.org/file.pdf'
    else raw.data[0].openAccessPdf.url = 'javascript:alert(1)'
    respond(JSON.stringify(raw))
    expect((await call(id))[0].pdfUrl).toBeUndefined()
  })
})

describe('backend errors and valid empty responses', () => {
  it.each(jsonIds)('%s accepts an empty results array', async (id) => {
    respond(setRows(id, []))
    expect(await call(id)).toEqual([])
  })
  it('accepts an empty Atom feed', async () => {
    respond('<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty fixture</title></feed>')
    expect(await call('arxiv')).toEqual([])
  })
  it.each(BACKEND_IDS.flatMap((id) => [401, 403, 429, 500].map((status) => ({ id, status, retryable: status === 429 || status === 500 }))))(
    '$id sanitizes HTTP $status and preserves retry classification',
    async ({ id, status, retryable }) => {
      respond('synthetic-test-key/private-query/internal-response', status)
      const error = await call(id).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(BackendError)
      expect(error).toMatchObject({ status, retryable })
      expect(String(error)).not.toMatch(/synthetic-test-key|private-query|internal-response/)
    }
  )
  it.each(BACKEND_IDS)('%s sanitizes network/timeout errors without copying cause', async (id) => {
    context.fetch.mockRejectedValue(new Error('synthetic-test-key/private-query/socket timeout'))
    const error = await call(id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ retryable: true })
    expect(error).not.toHaveProperty('cause')
    expect(String(error)).not.toMatch(/synthetic-test-key|private-query|socket timeout/)
  })
  it.each(BACKEND_IDS)('%s treats invalid response format as non-retryable', async (id) => {
    respond(id === 'arxiv' ? '<feed><entry>broken' : '{invalid-json synthetic-test-key private-query')
    const error = await call(id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ retryable: false })
    expect(String(error)).not.toMatch(/synthetic-test-key|private-query|invalid-json/)
  })
  it.each(jsonIds)('%s rejects wrong JSON structures without claiming empty success', async (id) => {
    for (const bad of ['{}', '[]', setRows(id, [null]), setRows(id, ['not-a-result'])]) {
      respond(bad)
      await expect(call(id)).rejects.toMatchObject({ retryable: false })
    }
  })
  it('arXiv rejects RSS and malformed Atom entries', async () => {
    for (const bad of [
      '<rss><channel><title>Wrong feed</title></channel></rss>',
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry>not-an-object</entry></feed>'
    ]) {
      respond(bad)
      await expect(call('arxiv')).rejects.toMatchObject({ retryable: false })
    }
  })
  it.each([1701, '1701'])('Zhipu handles concurrency code %s with numeric/string representation', async (code) => {
    respond(JSON.stringify({ error: { code, message: 'synthetic-test-key private-query' } }))
    await expect(call('zhipu')).rejects.toMatchObject({ retryable: true })
    respond(JSON.stringify({ error: { code } }), 400)
    await expect(call('zhipu')).rejects.toMatchObject({ status: 400, retryable: true })
    respond(JSON.stringify({ error: { code } }), 403)
    await expect(call('zhipu')).rejects.toMatchObject({ status: 403, retryable: false })
  })
})

describe('backend credential/redirect/fixture isolation', () => {
  it.each(['bocha', 'zhipu', 'tavily', 'brave', 'exa', 'serper'] as const)(
    '%s refuses missing required Key before transport',
    async (id) => {
      await expect(call(id, {}, { key: null, baseUrl: null })).rejects.toMatchObject({ retryable: false })
      expect(context.fetch).not.toHaveBeenCalled()
    }
  )
  it.each(BACKEND_IDS)('%s sanitizes a refused cross-origin redirect', async (id) => {
    context.fetch.mockImplementation(async (_url, options) => {
      options!.validateUrl!('https://foreign.example.org/?private-query=synthetic-test-key')
      return { status: 200, text: fixture(id), bytes: new Uint8Array(), headers: new Headers() }
    })
    const error = await call(id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ retryable: false })
    expect(String(error)).not.toMatch(/private-query|synthetic-test-key/)
  })
  it.each(BACKEND_IDS)('%s uses only a development loopback override and preserves query values', async (id) => {
    vi.stubEnv('JIWEI_SEARCH_BASE', 'http://127.0.0.1:9000/prefix')
    respond(fixture(id))
    await call(id)
    expect(capture().url.origin).toBe('http://127.0.0.1:9000')
    expect(capture().url.pathname).toBe('/prefix/' + id)
    if (id === 'brave') expect(capture().url.searchParams.get('q')).toBe('联网 & retrieval site:example.org')
    if (id === 'arxiv') expect(capture().url.searchParams.get('search_query')).toBe('all:联网 & retrieval')
  })
  it('preserves Serper news suffix on a fixture endpoint', async () => {
    vi.stubEnv('JIWEI_SEARCH_BASE', 'http://localhost:9000/')
    respond(fixture('serper-news'))
    await call('serper', { type: 'news' })
    expect(capture().url.href).toBe('http://localhost:9000/serper/news')
  })
  it.each(['https://public.example.org', 'http://127.0.0.1:9000/?query=x', 'http://user:pass@localhost:9000', 'file:///tmp/search'])(
    'refuses unsafe fixture override %s',
    async (base) => {
      vi.stubEnv('JIWEI_SEARCH_BASE', base)
      await expect(call('bocha')).rejects.toMatchObject({ retryable: false })
      expect(context.fetch).not.toHaveBeenCalled()
    }
  )
  it('ignores a fixture override in packaged builds', async () => {
    context.packaged = true
    vi.stubEnv('JIWEI_SEARCH_BASE', 'https://public.example.org')
    respond(fixture('bocha'))
    await call('bocha')
    expect(capture().url.href).toBe('https://api.bochaai.com/v1/web-search')
  })
  it.each([
    'http://public.example.org',
    'https://user:pass@search.example.org',
    'https://search.example.org/?q=x',
    'https://search.example.org/#hash',
    'file:///tmp/search'
  ])('revalidates SearXNG instance %s on each request', async (baseUrl) => {
    await expect(call('searxng', {}, { key: null, baseUrl })).rejects.toMatchObject({ retryable: false })
    expect(context.fetch).not.toHaveBeenCalled()
  })
})
