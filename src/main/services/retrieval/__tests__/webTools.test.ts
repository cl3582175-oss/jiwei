import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import * as schema from '../../../db/knowledgeSchema'
import type { AgentSession } from '../../ai/tools'
import type { WebResult } from '@shared/retrieval'
import type { externalFetch } from '../../externalFetch'

const state = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  temp: '',
  blocked: [] as string[],
  cautious: false,
  search: vi.fn(),
  academic: vi.fn(),
  fetch: vi.fn<typeof externalFetch>(),
  render: vi.fn(),
  worker: vi.fn(),
  save: vi.fn(),
  budget: vi.fn(),
  ready: vi.fn(),
  embedding: vi.fn(),
  embeddingSent: [] as ('query' | 'doc')[]
}))
vi.mock('../../../db', () => ({ getDb: () => state.db, getSqlite: () => state.sqlite }))
vi.mock('../../../db/profile', () => ({ profileDb: () => ({ prepare: () => ({ all: () => [] }) }) }))
vi.mock('electron', async () => {
  const { tmpdir } = await import('node:os')
  return {
    app: { getPath: () => state.temp || tmpdir(), getAppPath: () => process.cwd(), isPackaged: true, getLocale: () => 'en' },
    nativeImage: {},
    nativeTheme: {},
    BrowserWindow: { getAllWindows: () => [] },
    net: {},
    safeStorage: {}
  }
})
vi.mock('../../settings', () => ({
  getSettings: () => ({
    language: 'en',
    review: { retention: 0.9 },
    ai: { disabledSkills: [] },
    browser: { aiBlockedSites: state.blocked },
    retrieval: {
      mode: 'auto',
      preferZh: null,
      preferEn: null,
      academic: true,
      cautious: state.cautious,
      dailyLimit: 300,
      trustedSites: [],
      lowTrustSites: []
    }
  })
}))
vi.mock('../../device', () => ({ deviceId: () => 'test' }))
vi.mock('../../../events', () => ({ emit: vi.fn() }))
vi.mock('../../mcp/client', () => ({ assistantMcpTools: async () => ({ tools: {}, meta: {} }) }))
vi.mock('../../mail/tools', () => ({ mailTools: () => ({ tools: {}, meta: {} }) }))
vi.mock('../../ai/embedding', () => ({ isReady: state.ready, embed: state.embedding }))
vi.mock('../../browser/manager', () => ({ browserState: () => ({ tabs: [] }), openTab: vi.fn() }))
vi.mock('../../agent/usage', () => ({ checkBudget: state.budget }))
vi.mock('../../jobs', () => ({ runInWorker: state.worker }))
vi.mock('../../sources', () => ({ saveWebPage: state.save }))
vi.mock('../render', () => ({ renderPage: state.render }))
vi.mock('../gateway', () => ({ searchWeb: state.search, searchAcademic: state.academic }))
vi.mock('../../externalFetch', async (original) => ({
  ...(await original<typeof import('../../externalFetch')>()),
  externalFetch: state.fetch
}))
import { withRun } from '../../agent/context'
import { setMessageLanguage } from '../../../lib/messages'
import { assertPageReadable, getPage, readUrl } from '../reader'
import { urlKey } from '../backends/normalize'
import { BACKEND_INFO } from '@shared/retrieval'
import { scoreWeb } from '../scoring'
import { buildWebTools, passageHit, readForSession, searchForSession, snippetHit } from '../../ai/webTools'

const run = <T>(fn: () => T): T => withRun({ purpose: 'chat', caller: 'assistant' }, fn)
const paragraph = 'Public fixture facts explain reliable evidence, citations and reproducible article passages. '.repeat(9)
const html =
  '<html><head><title>Fixture article</title><meta property="article:published_time" content="2029-12-01"></head><body><article>' +
  Array.from({ length: 6 }, (_, i) => '<p>' + paragraph + ' Ending facts ' + i + '.</p>').join('') +
  '</article></body></html>'
const response = (body = html) => ({
  status: 200,
  text: body,
  bytes: new TextEncoder().encode(body),
  headers: new Headers({ 'content-type': 'text/html' })
})
const result = (fields: Partial<WebResult> = {}): WebResult => ({
  url: 'https://example.org/article',
  title: 'Public result',
  snippet: 'Search-engine excerpt with facts.',
  site: 'Example',
  backend: 'tavily',
  rank: 1,
  ...fields
})
const session = (fields: Partial<AgentSession> = {}): AgentSession => ({
  zh: true,
  model: '',
  tier: 'basic',
  scope: { type: 'none' },
  incognito: false,
  conversationId: '',
  messageId: '',
  hits: [],
  skills: [],
  web: {
    gate: { status: 'available', offerTools: true, preSearch: false, timeSensitive: false, explicitAsk: false, coverage: 'none' },
    searches: 0,
    reads: 0,
    allowedUrls: new Set(),
    userText: 'public fixture'
  },
  ...fields
})
function source(id: string, url: string, fields: { aiExcluded?: boolean; deletedAt?: number } = {}): void {
  state
    .db!.insert(schema.sources)
    .values({
      id,
      url,
      title: 'Saved ' + id,
      kind: 'web',
      accessedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      ...fields
    })
    .run()
}
async function call(tools: ToolSet, name: string, input: unknown, signal?: AbortSignal): Promise<string> {
  const t = tools[name]
  const parsed = (t.inputSchema as { parse(value: unknown): unknown }).parse(input)
  return String(await run(() => t.execute!(parsed, { toolCallId: 'test', messages: [], context: undefined, abortSignal: signal })))
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  state.sqlite = new Database(':memory:')
  state.sqlite.loadExtension(getLoadablePath())
  state.db = drizzle(state.sqlite, { schema })
  migrate(state.db, { migrationsFolder: 'resources/migrations' })
  state.temp = await mkdtemp(join(tmpdir(), 'jiwei-web-tools-test-'))
  state.blocked = []
  state.cautious = false
  state.search.mockReset().mockResolvedValue({ results: [result()], backend: 'tavily' })
  state.academic.mockReset().mockResolvedValue({ results: [result({ backend: 'openalex' })], backends: ['openalex', 'arxiv'] })
  state.fetch.mockReset().mockImplementation(async (url, opts) => {
    opts?.validateUrl?.(url)
    return response()
  })
  state.render.mockReset()
  state.worker.mockReset()
  state.save.mockReset()
  state.budget.mockReset()
  state.ready.mockReset().mockResolvedValue(false)
  state.embedding.mockReset().mockResolvedValue([])
  state.embeddingSent = []
  setMessageLanguage('en')
})
afterEach(async () => {
  state.sqlite?.close()
  state.db = null
  state.sqlite = null
  await rm(state.temp, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('web tool availability and public contract', () => {
  it('offers both web tools with KB scope none, and leaves guarding to the shared wrapper', async () => {
    state.cautious = true
    const s = session(),
      built = buildWebTools(s)
    expect(Object.keys(built.tools).sort()).toEqual(['read_url', 'web_search'])
    for (const name of ['read_url', 'web_search']) expect(built.meta[name]).toMatchObject({ level: 'read', untrusted: true, confirm: true })
    expect(built.meta.web_search.describe?.({ query: 'public query' })).toEqual({ title: '联网搜索', detail: 'public query' })
    expect(built.meta.read_url.describe?.({ url: 'https://example.org/article' })).toEqual({
      title: '读取网页',
      detail: 'https://example.org/article'
    })
    const text = await call(built.tools, 'web_search', { query: ' public fixture ' })
    expect(text).not.toContain('<external-data')
    expect(text).toContain('（给助手的说明，不要转述给用户：结果来自 ' + BACKEND_INFO.tavily.name + '；本轮还可搜索 2 次。')
    expect(text).toContain('先用 read_url 读 1–2 个最相关')
    expect(s.hits).toHaveLength(1)
    expect(s.hits[0]).toMatchObject({ parentType: 'web', snippetOnly: true, ownerId: 'snip:' + urlKey(result().url) })
  })
  it.each(['off', 'unconfigured', 'context', 'not-allowed'] as const)('offers no tools when gate is %s', (status) => {
    const s = session()
    s.web.gate = { ...s.web.gate, status, offerTools: false }
    expect(buildWebTools(s)).toEqual({ tools: {}, meta: {} })
  })
  it('has exact bilingual descriptions, input limits and English metadata', () => {
    const zh = buildWebTools(session()),
      en = buildWebTools(session({ zh: false }))
    expect(zh.tools.web_search.description).toBe(
      '联网搜索公开网页或学术文献。知识库片段不够、或问题涉及最新信息时使用。查询要短，用关键词，不超过 100 字，不得包含用户的私人信息。结果带编号，可以用 [编号] 引用；但结果里的摘要只是搜索引擎截取的片段，数字、日期和关键结论要先用 read_url 读原文再引用。type=academic 检索论文，type=news 检索近期新闻。'
    )
    expect(en.tools.web_search.description).toBe(
      "Search the public web or academic literature. Use when the knowledge base is insufficient or the question needs current information. Keep queries short (keywords, at most 100 characters) and never include the user's private information. Results are numbered and citable as [n], but snippets are search-engine excerpts: read the page with read_url before citing numbers, dates or key conclusions. type=academic searches papers; type=news searches recent news."
    )
    expect(zh.tools.read_url.description).toBe(
      '读取一个网页或 PDF 的正文，返回与问题最相关的段落（带编号，可以引用）。url 只能来自本轮 web_search 的结果、用户给出的网址或上一轮引用过的网页。focus 写你想在页面里找什么，用网页本身的语言写（英文网页用英文）。'
    )
    expect(en.tools.read_url.description).toBe(
      "Read a web page or PDF and return the passages most relevant to the question (numbered, citable). The url must come from this turn's web_search results, a URL the user gave, or a page cited in the previous answer. Use focus to say what you are looking for, written in the page's own language."
    )
    expect(en.meta.web_search.describe?.({})).toEqual({ title: 'Web search', detail: '' })
    expect(en.meta.read_url.describe?.({})).toEqual({ title: 'Read web page', detail: '' })
    const searchSchema = zh.tools.web_search.inputSchema as { parse(v: unknown): unknown }
    expect(searchSchema.parse({ query: ' fixture ' })).toEqual({ query: 'fixture', type: 'web' })
    expect(() => searchSchema.parse({ query: 'x'.repeat(101) })).toThrow()
    expect(() => searchSchema.parse({ query: ' ' })).toThrow()
    expect(() => searchSchema.parse({ query: 'fixture', site: 'x'.repeat(101) })).toThrow()
    const readSchema = zh.tools.read_url.inputSchema as { parse(v: unknown): unknown }
    expect(() => readSchema.parse({ url: 'not a URL' })).toThrow()
    expect(() => readSchema.parse({ url: 'https://example.org', focus: 'x'.repeat(201) })).toThrow()
  })
  it('uses exact empty-result text in both languages', async () => {
    state.search.mockResolvedValue({ results: [], backend: null })
    expect(await call(buildWebTools(session()).tools, 'web_search', { query: 'fixture' })).toBe('没有搜到相关结果，可以换个关键词。')
    expect(await call(buildWebTools(session({ zh: false })).tools, 'web_search', { query: 'fixture' })).toBe(
      'No relevant results found. Try different keywords.'
    )
  })
  it('outputs English source annotations and preserves zero-valued academic metadata in the real numbering path', async () => {
    source('saved', result().url)
    state.search.mockResolvedValue({
      results: [result({ publishedAt: 0, year: 0, citations: 0, authors: ['Fixture Author'] })],
      backend: 'tavily'
    })
    const s = session({ zh: false })
    const text = await call(buildWebTools(s).tools, 'web_search', { query: 'fixture' })
    expect(text).toContain('[1] Web "Public result"')
    expect(text).toContain('published 1970-01-01')
    expect(text).toContain('cited 0')
    expect(text).toContain('Already saved in your library: "Saved saved", sourceId: saved; use source_read to read it')
    expect(text).toContain('; 2 searches remaining this turn.')
    expect(s.hits[0].meta?.year).toBe(0)
  })
})

describe('session search reservations and source privacy', () => {
  it.each([
    ['https://WWW.example.org:443/path?q=x', 'www.example.org'],
    ['example.org/path', 'example.org'],
    ['bad host name', undefined],
    ['https://user:pass@example.org/private', undefined],
    ['file:///private', undefined]
  ])('normalizes site %s without changing shared gateway behavior', async (site, expected) => {
    const s = session({ incognito: true }),
      c = new AbortController()
    await run(() => searchForSession(s, { query: 'public fixture', type: 'news', freshness: 'week', site }, c.signal))
    expect(state.search).toHaveBeenCalledWith('public fixture', {
      type: 'news',
      freshness: 'week',
      site: expected,
      count: 6,
      signal: c.signal,
      incognito: true
    })
    expect(s.web.searches).toBe(1)
  })
  it('routes academic-only sessions and uses all successful backend labels', async () => {
    const s = session()
    s.web.gate = { ...s.web.gate, status: 'academic-only' }
    await expect(run(() => searchForSession(s, { query: 'fixture' }))).rejects.toThrow('只能检索学术文献')
    expect(state.search).not.toHaveBeenCalled()
    const out = await run(() => searchForSession(s, { query: 'fixture', type: 'academic' }))
    expect(state.academic).toHaveBeenCalledWith('fixture', { count: 6, signal: undefined, incognito: false })
    expect(out.backendLabel).toContain(BACKEND_INFO.openalex.name)
    expect(out.backendLabel).toContain(BACKEND_INFO.arxiv.name)
    expect(s.web.searches).toBe(2)
  })
  it('allowlists a public academic PDF and recognizes an ordinary saved PDF through its URL', async () => {
    const pdfUrl = 'https://pdf.example.org/paper.pdf'
    source('saved-pdf', 'http://www.pdf.example.org/paper.pdf?utm_source=fixture')
    state.academic.mockResolvedValue({ results: [result({ pdfUrl, backend: 'openalex' })], backends: ['openalex'] })
    const s = session(),
      out = await run(() => searchForSession(s, { query: 'fixture', type: 'academic' }))
    expect(out.results[0].savedSource).toEqual({ id: 'saved-pdf', title: 'Saved saved-pdf' })
    expect(s.web.allowedUrls.has(urlKey(result().url)!)).toBe(true)
    expect(s.web.allowedUrls.has(urlKey(pdfUrl)!)).toBe(true)
  })
  it('filters excluded primary/PDF URLs before allowlisting and annotates only ordinary live saved sources', async () => {
    source('excluded', 'http://www.private.example.org/article/?utm_source=fixture', { aiExcluded: true })
    source('excluded-pdf', 'https://pdf.example.org/paper.pdf', { aiExcluded: true })
    source('saved', 'http://www.example.org/article?utm_source=fixture')
    source('deleted', 'https://example.org/deleted', { deletedAt: 1 })
    const items = [
      result({ url: 'https://private.example.org/article' }),
      result({ url: 'https://paper.example.org/item', pdfUrl: 'https://pdf.example.org/paper.pdf' }),
      result(),
      result({ url: 'https://example.org/deleted' })
    ]
    state.search.mockResolvedValue({ results: items, backend: 'tavily' })
    const s = session(),
      out = await run(() => searchForSession(s, { query: 'fixture' }))
    expect(out.results.map((item) => item.url)).toEqual([items[2].url, items[3].url])
    expect(out.results[0].savedSource).toEqual({ id: 'saved', title: 'Saved saved' })
    expect(out.results[1].savedSource).toBeUndefined()
    expect([...s.web.allowedUrls]).toEqual(out.results.map((item) => urlKey(item.url)))
    expect(s.web.allowedUrls.has(urlKey(items[1].pdfUrl!)!)).toBe(false)
    const text = await call(buildWebTools(session()).tools, 'web_search', { query: 'fixture' })
    expect(text).toContain('（已收藏在你的资料库：《Saved saved》，sourceId: saved，可以用 source_read 阅读）')
    expect(text).not.toContain('private.example.org')
  })
  it('rechecks privacy after the search await and rejects sensitive PDFs even when the landing page is public', async () => {
    state.search.mockImplementation(async () => {
      state.blocked = ['example.org']
      return {
        results: [result(), result({ url: 'https://paper.example.net/item', pdfUrl: 'https://paypal.com./private.pdf' })],
        backend: 'tavily'
      }
    })
    const s = session(),
      out = await run(() => searchForSession(s, { query: 'fixture' }))
    expect(out.results).toEqual([])
    expect(s.web.allowedUrls.size).toBe(0)
  })
  it('reserves the three search slots before awaiting and consumes failed requests without leaking errors', async () => {
    const rejects: ((reason: unknown) => void)[] = []
    state.search.mockImplementation(() => new Promise((_resolve, reject) => rejects.push(reject)))
    const s = session(),
      tasks = [1, 2, 3].map(() => run(() => searchForSession(s, { query: 'fixture' })).catch((e: unknown) => e))
    expect(s.web.searches).toBe(3)
    await expect(run(() => searchForSession(s, { query: 'fixture' }))).rejects.toThrow('本轮联网搜索次数已用完')
    expect(state.search).toHaveBeenCalledTimes(3)
    rejects.forEach((reject) => reject(new Error('synthetic-key private-query')))
    for (const error of await Promise.all(tasks)) expect(String(error)).not.toMatch(/synthetic-key|private-query/)
    expect(s.web.searches).toBe(3)
  })
})

describe('read whitelist, request reservations and numbered excerpts', () => {
  it('accepts a literal user URL, transfers signal/incognito and uses focus scoring with exact locators', async () => {
    const s = session({ incognito: true }),
      c = new AbortController()
    s.web.userText = 'Read https://example.org/article please'
    const out = await run(() => readForSession(s, 'https://example.org/article', 'public fixture', c.signal))
    expect(out.read.page.id).toMatch(/^tmp-/)
    expect(state.fetch.mock.calls[0][1]?.signal).toBe(c.signal)
    expect(s.web.reads).toBe(1)
    for (const p of out.selected) expect(out.read.page.text.slice(p.start, p.end)).toBe(p.text)
    const hit = passageHit(out.read, out.selected[0])
    expect(hit).toMatchObject({
      parentType: 'web',
      via: 'web',
      parentId: out.read.page.id,
      ownerId: out.read.page.id + ':' + out.selected[0].start,
      locator: 'chars=' + out.selected[0].start + '-' + out.selected[0].end
    })
  })
  it('does not accept a user-URL prefix', async () => {
    const prefix = session()
    prefix.web.userText = 'https://example.org/article-private'
    await expect(run(() => readForSession(prefix, 'https://example.org/article'))).rejects.toThrow('只能读取')
    expect(state.fetch).not.toHaveBeenCalled()
  })
  it('follows a server redirect from an allowed URL (DOI to publisher) and allowlists the target', async () => {
    const s = session()
    s.web.allowedUrls.add(urlKey('https://doi.org/10.1000/fixture')!)
    state.fetch.mockImplementation(async (url, opts) => {
      opts?.validateUrl?.(url)
      opts?.validateUrl?.('https://publisher.example.org/article')
      return response()
    })
    await expect(run(() => readForSession(s, 'https://doi.org/10.1000/fixture'))).resolves.toHaveProperty('read.page')
    expect(s.web.allowedUrls.has(urlKey('https://publisher.example.org/article')!)).toBe(true)
  })
  it('still applies site policy to redirect targets', async () => {
    const s = session()
    s.web.allowedUrls.add(urlKey('https://doi.org/10.1000/fixture')!)
    state.blocked = ['publisher.example.org']
    state.fetch.mockImplementation(async (url, opts) => {
      opts?.validateUrl?.(url)
      opts?.validateUrl?.('https://publisher.example.org/article')
      return response()
    })
    await expect(run(() => readForSession(s, 'https://doi.org/10.1000/fixture'))).rejects.toThrow()
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_pages').get()).toEqual({ n: 0 })
  })
  it('allows explicitly listed redirects but applies the same query cap to each target', async () => {
    const initial = 'https://example.org/article',
      final = 'https://docs.example.org/final'
    const s = session()
    s.web.allowedUrls = new Set([urlKey(initial)!, urlKey(final)!])
    state.fetch.mockImplementation(async (url, opts) => {
      opts?.validateUrl?.(url)
      opts?.validateUrl?.(final)
      return response()
    })
    await expect(run(() => readForSession(s, initial))).resolves.toHaveProperty('read.page')
    const long = 'https://docs.example.org/final?' + 'x'.repeat(201),
      another = 'https://example.org/another',
      next = session()
    next.web.allowedUrls = new Set([urlKey(another)!, urlKey(long)!])
    state.fetch.mockImplementation(async (url, opts) => {
      opts?.validateUrl?.(url)
      opts?.validateUrl?.(long)
      return response()
    })
    await expect(run(() => readForSession(next, another))).rejects.toThrow()
  })
  it.each([200, 201])('caps the URL query at200 characters, including a whitelisted query length %s', async (length) => {
    const url = 'https://example.org/article?' + 'q=' + 'x'.repeat(length - 2),
      s = session()
    s.web.allowedUrls.add(urlKey(url)!)
    if (length === 200) await expect(run(() => readForSession(s, url))).resolves.toHaveProperty('read.page')
    else {
      await expect(run(() => readForSession(s, url))).rejects.toThrow()
      expect(state.fetch).not.toHaveBeenCalled()
    }
  })
  it('reserves four read slots while transport is pending and consumes failures', async () => {
    const rejects: ((reason: unknown) => void)[] = []
    state.fetch.mockImplementation(() => new Promise((_resolve, reject) => rejects.push(reject)))
    const s = session()
    const tasks = [1, 2, 3, 4].map((i) => {
      const url = 'https://example.org/read-' + i
      s.web.allowedUrls.add(urlKey(url)!)
      return run(() => readForSession(s, url)).catch((e: unknown) => e)
    })
    expect(s.web.reads).toBe(4)
    s.web.allowedUrls.add(urlKey('https://example.org/read-5')!)
    await expect(run(() => readForSession(s, 'https://example.org/read-5'))).rejects.toThrow('本轮读取网页次数已用完')
    expect(state.fetch).toHaveBeenCalledTimes(4)
    rejects.forEach((reject) => reject(new Error('private-query synthetic-key')))
    for (const error of await Promise.all(tasks)) expect(String(error)).not.toMatch(/private-query|synthetic-key/)
    expect(s.web.reads).toBe(4)
  })
  it('returns numbered page passages, method/date metadata and the low-relevance fallback text', async () => {
    const s = session()
    s.web.allowedUrls.add(urlKey(result().url)!)
    const text = await call(buildWebTools(s).tools, 'read_url', { url: result().url, focus: 'unrelated obscure terms' })
    expect(text).toContain('网页《Fixture article》')
    expect(text).toContain('发布于 2029-12-01')
    expect(text).toContain('读取方式（网页）')
    expect(text).toMatch(/（共 \d+ 段，这里是最相关的 3 段）/)
    expect(text).toContain('（这些段落和问题的相关度较低）')
    expect(s.hits).toHaveLength(3)
    expect(s.hits.every((hit) => hit.parentType === 'web' && hit.locator?.startsWith('chars='))).toBe(true)
  })
  it('outputs English reading metadata and uses the user text when focus is omitted', async () => {
    const s = session({ zh: false })
    s.web.userText = 'public fixture https://example.org/article'
    const text = await call(buildWebTools(s).tools, 'read_url', { url: result().url })
    expect(text).toContain('Web "Fixture article"')
    expect(text).toContain('published 2029-12-01')
    expect(text).toContain('read by web')
    expect(text).toMatch(/\(\d+ passages in total; these are the \d+ most relevant\)/)
    expect(text).not.toContain('low relevance')
  })
  it('rejects a rendered main-frame redirect to a blocked site', async () => {
    state.fetch.mockResolvedValue({ ...response('<html><body>Render bootstrap.</body></html>'), status: 403 })
    state.blocked = ['other.example.org']
    state.render.mockImplementation(async (_url, opts) => {
      opts.validateUrl('https://other.example.org/page')
      return { html, finalUrl: 'https://other.example.org/page' }
    })
    const s = session()
    s.web.allowedUrls.add(urlKey(result().url)!)
    await expect(run(() => readForSession(s, result().url))).rejects.toThrow()
    expect(state.render).toHaveBeenCalledTimes(1)
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_pages').get()).toEqual({ n: 0 })
  })
  it('rechecks captured finalUrl after scoring even if the snapshot is cleared while privacy changes', async () => {
    state.fetch.mockImplementation(async (url, opts) => {
      opts?.validateUrl?.(url)
      opts?.validateUrl?.('https://docs.example.org/final')
      return response()
    })
    state.ready.mockImplementationOnce(async () => {
      state.sqlite!.prepare('DELETE FROM web_pages').run()
      state.blocked = ['docs.example.org']
      return false
    })
    const s = session()
    s.web.allowedUrls = new Set([urlKey(result().url)!, urlKey('https://docs.example.org/final')!])
    await expect(run(() => readForSession(s, result().url))).rejects.toThrow()
    expect(state.ready).toHaveBeenCalledTimes(1)
    expect(s.hits).toEqual([])
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_pages').get()).toEqual({ n: 0 })
  })
  it('sanitizes aborted search/read causes before any transport and consumes the reserved attempts', async () => {
    const c = new AbortController(),
      s = session()
    c.abort('private-query synthetic-key')
    const searched = await run(() => searchForSession(s, { query: 'fixture' }, c.signal)).catch((e: unknown) => e)
    const read = await run(() => readForSession(s, result().url, undefined, c.signal)).catch((e: unknown) => e)
    for (const error of [searched, read]) {
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toMatch(/private-query|synthetic-key/)
    }
    expect(state.search).not.toHaveBeenCalled()
    expect(state.fetch).not.toHaveBeenCalled()
    expect(s.web.searches).toBe(1)
    expect(s.web.reads).toBe(1)
  })
})

describe('hit metadata and current snapshot AI policy', () => {
  it('preserves academic metadata, including numeric zero, and never treats snippets as saved snapshots', () => {
    const hit = snippetHit(
      result({
        publishedAt: 0,
        authors: ['Fixture Author'],
        year: 0,
        citations: 0,
        doi: '10.1/fixture',
        venue: 'Fixture venue',
        pdfUrl: 'https://example.org/paper.pdf'
      })
    )
    expect(hit).toMatchObject({
      parentType: 'web',
      parentId: '',
      locator: null,
      snippetOnly: true,
      learnedAt: 0,
      status: null,
      origin: null,
      via: 'web',
      meta: {
        authors: ['Fixture Author'],
        year: 0,
        citations: 0,
        doi: '10.1/fixture',
        venue: 'Fixture venue',
        pdfUrl: 'https://example.org/paper.pdf'
      }
    })
  })
  it('preserves passage suspicion, scores and epoch timestamps in citation metadata', () => {
    const passage = { index: 0, start: 0, end: 4, text: 'Zero', suspicious: true, score: 0 }
    const read = {
      page: {
        id: 'snapshot',
        url: result().url,
        title: 'Title',
        siteName: 'Site',
        publishedAt: 0,
        fetchedAt: 0,
        method: 'fetch' as const,
        text: 'Zero'
      },
      passages: [passage]
    }
    expect(passageHit(read, passage)).toMatchObject({
      score: 0,
      learnedAt: 0,
      updatedAt: 0,
      suspicious: true,
      locator: 'chars=0-4',
      ownerId: 'snapshot:0'
    })
  })
  it.each([false, true])('blocks a snapshot finalUrl after current website privacy changes (incognito=%s)', async (incognito) => {
    state.fetch.mockImplementation(async (url, opts) => {
      opts?.validateUrl?.(url)
      opts?.validateUrl?.('https://docs.example.org/final')
      return response()
    })
    const read = await run(() => readUrl(result().url, { incognito }))
    expect(() => assertPageReadable(read.page.id)).not.toThrow()
    expect(getPage(read.page.id)).toEqual(read.page)
    expect(getPage(read.page.id)).not.toHaveProperty('finalUrl')
    state.blocked = ['docs.example.org']
    expect(() => assertPageReadable(read.page.id)).toThrow()
    expect(getPage(read.page.id)).toEqual(read.page)
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_pages').get()).toEqual({ n: incognito ? 0 : 1 })
  })
  it('retains finalUrl in an incognito clone of a persistent cache entry and checks new source exclusion', async () => {
    state.fetch.mockImplementation(async (url, opts) => {
      opts?.validateUrl?.(url)
      opts?.validateUrl?.('https://docs.example.org/final')
      return response()
    })
    const ordinary = await run(() => readUrl(result().url))
    const clone = await run(() => readUrl(result().url, { incognito: true }))
    expect(clone.page.id).toMatch(/^tmp-/)
    expect(state.fetch).toHaveBeenCalledTimes(1)
    source('excluded-final', 'http://www.docs.example.org/final?utm_source=fixture', { aiExcluded: true })
    expect(() => assertPageReadable(ordinary.page.id)).toThrow()
    expect(() => assertPageReadable(clone.page.id)).toThrow()
    expect(() => assertPageReadable('missing-snapshot')).not.toThrow()
    expect(() => assertPageReadable('tmp-missing-snapshot')).not.toThrow()
  })
})

describe('embedding send privacy boundary', () => {
  const preparedSession = (): AgentSession => {
    const s = session()
    s.web.allowedUrls = new Set([urlKey(result().url)!, urlKey('https://docs.example.org/final')!])
    state.fetch.mockImplementation(async (url, opts) => {
      opts?.validateUrl?.(url)
      opts?.validateUrl?.('https://docs.example.org/final')
      return response()
    })
    state.ready.mockResolvedValue(true)
    // 受控模型发送边界遵守embed第4参数合同；record只发生在同步guard通过之后。
    state.embedding.mockImplementation(async (texts: string[], kind: 'query' | 'doc', _titles?: string[], beforeSend?: () => void) => {
      beforeSend?.()
      state.embeddingSent.push(kind)
      beforeSend?.()
      return texts.map(() => [1, 0])
    })
    return s
  }
  it.each(['initial URL', 'final URL', 'excluded final source', 'cleared snapshot final URL'])(
    'blocks before query/document payload when privacy changes for %s during readiness',
    async (change) => {
      const s = preparedSession()
      state.ready.mockImplementationOnce(async () => {
        if (change === 'initial URL') state.blocked = ['example.org']
        else if (change === 'final URL') state.blocked = ['docs.example.org']
        else if (change === 'cleared snapshot final URL') {
          state.sqlite!.prepare('DELETE FROM web_pages').run()
          state.blocked = ['docs.example.org']
        } else source('excluded-final-before-send', 'https://docs.example.org/final', { aiExcluded: true })
        return true
      })
      const error = await run(() => readForSession(s, result().url)).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('PagePolicyError')
      expect(state.embeddingSent).toEqual([])
      expect(s.hits).toEqual([])
    }
  )
  it('blocks a document payload when finalUrl is excluded between query completion and document send', async () => {
    const s = preparedSession()
    state.embedding.mockImplementation(async (texts: string[], kind: 'query' | 'doc', _titles?: string[], beforeSend?: () => void) => {
      beforeSend?.()
      state.embeddingSent.push(kind)
      if (kind === 'query')
        queueMicrotask(() => source('excluded-final-after-query', 'https://docs.example.org/final', { aiExcluded: true }))
      beforeSend?.()
      return texts.map(() => [1, 0])
    })
    const error = await run(() => readForSession(s, result().url)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('PagePolicyError')
    expect(state.embeddingSent).toEqual(['query'])
    expect(s.hits).toEqual([])
  })
  it('threads a synchronous guard through real scoring and continues both allowed query/document sends', async () => {
    const s = preparedSession()
    const out = await run(() => readForSession(s, result().url))
    expect(state.embeddingSent).toEqual(['query', 'doc'])
    expect(state.embedding.mock.calls.every((args) => typeof args[3] === 'function')).toBe(true)
    expect(out.selected.length).toBeGreaterThan(0)
    expect(out.selected.every((passage) => !passage.fallback)).toBe(true)
  })
  it('stops both payloads and removes the abort cause when cancellation occurs during readiness', async () => {
    const s = preparedSession(),
      c = new AbortController()
    state.ready.mockImplementationOnce(async () => {
      c.abort('private-query synthetic-key')
      return true
    })
    const error = await run(() => readForSession(s, result().url, undefined, c.signal)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toMatch(/private-query|synthetic-key/)
    expect(state.embeddingSent).toEqual([])
    expect(s.web.reads).toBe(1)
  })
  it.each([false, true])('protects the post-return captured guard after clearing the snapshot (blockFinal=%s)', async (blockFinal) => {
    const s = preparedSession()
    const out = await run(() => readForSession(s, result().url))
    expect(state.embeddingSent).toEqual(['query', 'doc'])
    state.sqlite!.prepare('DELETE FROM web_pages').run()
    expect(getPage(out.read.page.id)).toBeNull()
    state.embeddingSent = []
    if (blockFinal) state.blocked = ['docs.example.org']
    const candidate = {
      pageId: out.read.page.id,
      url: out.read.page.url,
      title: out.read.page.title,
      text: out.selected[0].text,
      site: out.read.page.siteName,
      publishedAt: out.read.page.publishedAt,
      fetchedAt: out.read.page.fetchedAt
    }
    if (blockFinal) {
      await expect(
        run(() => scoreWeb([candidate], s.web.userText, { timeSensitive: false, beforeSend: out.assertReadable }))
      ).rejects.toThrow()
      expect(state.embeddingSent).toEqual([])
    } else {
      expect(out.assertReadable).toBeTypeOf('function')
      const scored = await run(() => scoreWeb([candidate], s.web.userText, { timeSensitive: false, beforeSend: out.assertReadable }))
      expect(scored).toHaveLength(1)
      expect(state.embeddingSent).toEqual(['query', 'doc'])
    }
    expect(s.web.reads).toBe(1)
  })
  it('registers a page guard for direct read_url output that survives clearing and rejects a newly excluded final source', async () => {
    const s = preparedSession()
    await call(buildWebTools(s).tools, 'read_url', { url: result().url })
    expect(s.hits.length).toBeGreaterThan(0)
    const pageId = s.hits[0].parentId
    const guard = s.web.pageGuards?.get(pageId)
    expect(guard).toBeTypeOf('function')
    state.sqlite!.prepare('DELETE FROM web_pages').run()
    expect(getPage(pageId)).toBeNull()
    expect(() => guard!()).not.toThrow()
    source('direct-excluded-final', 'http://www.docs.example.org/final?utm_source=fixture', { aiExcluded: true })
    expect(() => guard!()).toThrow()
    expect(s.web.reads).toBe(1)
  })
})
