import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { and, isNotNull, isNull } from 'drizzle-orm'
import { BACKEND_INFO, FreshnessSchema, SearchTypeSchema, type Freshness, type SearchType, type WebResult } from '@shared/retrieval'
import type { SearchHit } from '@shared/types'
import { getDb } from '../../db'
import { sources } from '../../db/schema'
import type { ToolMeta } from '../agent/wrap'
import { getSettings } from '../settings'
import { searchAcademic, searchWeb } from '../retrieval/gateway'
import { urlKey } from '../retrieval/backends/normalize'
import { DailyLimitError } from '../retrieval/calls'
import { PrivacyError } from '../retrieval/privacyGuard'
import { WebPolicyError } from '../retrieval/policy'
import { assertReadableUrl, PagePolicyError } from '../retrieval/pagePolicy'
import { assertPageReadable, readUrl, type Passage, type ReadPage } from '../retrieval/reader'
import { selectPassages } from '../retrieval/scoring'
import { numberHits, type AgentSession } from './tools'

export const SEARCH_PER_TURN = 3
export const READ_PER_TURN = 4
export type SessionWebResult = WebResult & { savedSource?: { id: string; title: string } }
export type SelectedPassage = Passage & { score: number; fallback: boolean }
export interface SessionSearchInput {
  query: string
  type?: SearchType
  freshness?: Freshness
  site?: string
}
const SearchInput = z.object({
  query: z.string().trim().min(1).max(100),
  type: SearchTypeSchema.default('web'),
  freshness: FreshnessSchema.optional(),
  site: z.string().max(100).optional()
})
const ReadInput = z.object({ url: z.string().url().max(2000), focus: z.string().max(200).optional() })
const messages = {
  searchLimit: [
    '本轮联网搜索次数已用完，请根据已有资料回答，并说明哪些内容没能核实。',
    'The web search limit for this turn has been reached. Answer from the available material and explain what could not be verified.'
  ],
  readLimit: [
    '本轮读取网页次数已用完，请根据已有资料回答。',
    'The page reading limit for this turn has been reached. Answer from the available material.'
  ],
  academic: [
    '没有配置网页搜索服务，只能检索学术文献（type=academic）。',
    'No web search service is configured; only academic literature can be searched (type=academic).'
  ],
  scope: [
    '只能读取本轮搜索结果、你给出的网址或上一轮引用过的网页。',
    "Only this turn's search results, URLs you provided, or pages cited in the previous answer can be read."
  ],
  unavailable: ['本轮未开启联网，请根据已有资料回答。', 'Web access is unavailable for this turn. Answer from the available material.'],
  invalidSearch: ['搜索参数无效，请使用不超过 100 字的关键词。', 'Invalid search input. Use keywords of at most 100 characters.'],
  canceled: ['联网操作已取消', 'Web operation canceled'],
  searchFailed: [
    '联网搜索暂时失败，请稍后再试或检查设置中的搜索服务',
    'Web search failed temporarily. Try again later or check the search services in settings.'
  ],
  readFailed: ['网页读取失败，请稍后再试', 'Page reading failed. Try again later']
} as const
class WebToolError extends Error {
  constructor(zh: boolean, reason: keyof typeof messages) {
    super(messages[reason][zh ? 0 : 1])
    this.name = 'WebToolError'
  }
}
function available(session: AgentSession): void {
  if (!['available', 'academic-only'].includes(session.web.gate.status)) throw new WebToolError(session.zh, 'unavailable')
}
/** 网关/reader已经净化已知错误；未知边界错误不能携带查询、Key或原始取消原因进入工具审计。 */
function safeError(session: AgentSession, error: unknown, kind: 'search' | 'read', signal?: AbortSignal): Error {
  if (signal?.aborted) return new WebToolError(session.zh, 'canceled')
  if (
    error instanceof WebToolError ||
    error instanceof DailyLimitError ||
    error instanceof PrivacyError ||
    error instanceof WebPolicyError ||
    error instanceof PagePolicyError
  )
    return error
  if (kind === 'read' && error instanceof Error) {
    // 这两个私有错误类只在reader/render内以固定文案构造，transport原始错误不会以它们的名字返回。
    if (['ReadError', 'RenderError'].includes(error.name)) return error
    if (/^(?:网页打不开（HTTP \d{3}）|Page could not be opened \(HTTP \d{3}\))$/.test(error.message)) return new Error(error.message)
  }
  return new WebToolError(session.zh, kind === 'search' ? 'searchFailed' : 'readFailed')
}
function siteHost(value?: string): string | undefined {
  if (!value?.trim()) return undefined
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value.trim()) ? value.trim() : 'https://' + value.trim())
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined
    const host = url.hostname.toLowerCase().replace(/\.+$/, '')
    return /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(host) ? host : undefined
  } catch {
    return undefined
  }
}
function readableResult(result: WebResult): boolean {
  try {
    assertReadableUrl(result.url)
    if (result.pdfUrl) assertReadableUrl(result.pdfUrl)
    return true
  } catch (error) {
    if (error instanceof PagePolicyError) return false
    throw error
  }
}
export async function searchForSession(
  session: AgentSession,
  params: SessionSearchInput,
  signal?: AbortSignal
): Promise<{ results: SessionWebResult[]; backendLabel: string }> {
  available(session)
  if (session.web.searches >= SEARCH_PER_TURN) throw new WebToolError(session.zh, 'searchLimit')
  // 同步预留，避免并发工具调用穿透本轮上限；参数/请求失败也不回退，以免无限重试。
  session.web.searches++
  try {
    if (signal?.aborted) throw new WebToolError(session.zh, 'canceled')
    const parsed = SearchInput.safeParse(params)
    if (!parsed.success) throw new WebToolError(session.zh, 'invalidSearch')
    const { query, type, freshness, site } = parsed.data
    if (session.web.gate.status === 'academic-only' && type !== 'academic') throw new WebToolError(session.zh, 'academic')
    let raw: WebResult[], backendLabel: string
    if (type === 'academic') {
      const searched = await searchAcademic(query, { count: 6, signal, incognito: session.incognito })
      raw = searched.results
      backendLabel = searched.backends.map((id) => BACKEND_INFO[id].name).join(' / ') || '—'
    } else {
      const searched = await searchWeb(query, { type, freshness, site: siteHost(site), count: 6, signal, incognito: session.incognito })
      raw = searched.results
      backendLabel = searched.backend ? BACKEND_INFO[searched.backend].name : '—'
    }
    if (signal?.aborted) throw new WebToolError(session.zh, 'canceled')
    const saved = raw.length
      ? getDb()
          .select({ id: sources.id, title: sources.title, url: sources.url })
          .from(sources)
          .where(and(isNotNull(sources.url), isNull(sources.deletedAt)))
          .all()
      : []
    // 排除主URL和PDF的当前策略必须先于allowlisting；这里只读资料元数据。
    const results = raw.filter(readableResult).map((result): SessionWebResult => {
      const keys = [urlKey(result.url), result.pdfUrl ? urlKey(result.pdfUrl) : null].filter((key): key is string => !!key)
      const matching = saved.find((source) => source.url !== null && keys.includes(urlKey(source.url) ?? ''))
      for (const key of keys) session.web.allowedUrls.add(key)
      return { ...result, ...(matching ? { savedSource: { id: matching.id, title: matching.title } } : {}) }
    })
    return { results, backendLabel }
  } catch (error) {
    throw safeError(session, error, 'search', signal)
  }
}
/** 必须匹配完整网址token；includes会错误授权用户网址的主机或路径前缀。 */
function literalUrl(text: string, value: string): boolean {
  const candidates = text.match(/https?:\/\/[^\s<>"'\u0060]+/gi) ?? []
  return candidates.some((candidate) => {
    if (candidate === value) return true
    while (/[)\]}>，。！？；：,.!?;:]$/u.test(candidate)) {
      candidate = candidate.slice(0, -1)
      if (candidate === value) return true
    }
    return false
  })
}
function validateSessionUrl(session: AgentSession, value: string): void {
  let key: string | null
  try {
    const parsed = new URL(value)
    key = urlKey(value)
    if (!key || value.length > 2000 || parsed.search.slice(1).length > 200) throw new Error()
  } catch {
    throw new WebToolError(session.zh, 'scope')
  }
  if (!session.web.allowedUrls.has(key) && !literalUrl(session.web.userText, value)) throw new WebToolError(session.zh, 'scope')
  assertReadableUrl(value)
  session.web.allowedUrls.add(key)
}
export async function readForSession(
  session: AgentSession,
  url: string,
  focus?: string,
  signal?: AbortSignal
): Promise<{ read: ReadPage; selected: SelectedPassage[]; assertReadable: () => void }> {
  available(session)
  if (session.web.reads >= READ_PER_TURN) throw new WebToolError(session.zh, 'readLimit')
  session.web.reads++
  try {
    if (signal?.aborted) throw new WebToolError(session.zh, 'canceled')
    validateSessionUrl(session, url)
    let finalUrl = url
    const read = await readUrl(url, {
      signal,
      incognito: session.incognito,
      // 重定向由已获准网址的服务器决定，不是模型自己拼出的网址（例如 DOI 跳到出版社页面）：
      // 只按网站策略检查目的地，并把它加入本轮可读范围。模型直接给出的网址仍须在白名单里。
      validateUrl: (target) => {
        assertReadableUrl(target)
        const key = urlKey(target)
        if (!key) throw new WebToolError(session.zh, 'scope')
        session.web.allowedUrls.add(key)
        finalUrl = target
      }
    })
    const pageId = read.page.id
    const beforeSend = (): void => {
      if (signal?.aborted) throw new WebToolError(session.zh, 'canceled')
      // 打分可能等待模型；每批发送前与返回前重查，缓存已被清理时也检查捕获的最终URL。
      validateSessionUrl(session, url)
      validateSessionUrl(session, finalUrl)
      assertPageReadable(pageId)
    }
    const selected = await selectPassages(read, focus || session.web.userText, {
      timeSensitive: session.web.gate.timeSensitive,
      beforeSend
    })
    beforeSend()
    // 本轮显式保存检查器，直接工具返回后仍能在模型发送/最终引用前检查，避免依赖已被清理的快照。
    session.web.pageGuards ??= new Map()
    session.web.pageGuards.set(pageId, beforeSend)
    // 后续重评分/组装也复用捕获的最终地址；此closure只留在主进程内，不进入IPC或快照视图。
    return { read, selected, assertReadable: beforeSend }
  } catch (error) {
    throw safeError(session, error, 'read', signal)
  }
}
export function snippetHit(result: WebResult): SearchHit {
  return {
    parentType: 'web',
    parentId: '',
    ownerId: 'snip:' + urlKey(result.url),
    title: result.title,
    text: result.snippet,
    locator: null,
    score: 0,
    learnedAt: result.publishedAt ?? null,
    updatedAt: Date.now(),
    status: null,
    origin: null,
    via: 'web',
    url: result.url,
    site: result.site ?? null,
    snippetOnly: true,
    meta: {
      authors: result.authors ? [...result.authors] : undefined,
      year: result.year,
      venue: result.venue,
      citations: result.citations,
      doi: result.doi,
      pdfUrl: result.pdfUrl
    }
  }
}
export function passageHit(read: ReadPage, passage: Passage & Partial<{ score: number }>): SearchHit {
  return {
    parentType: 'web',
    parentId: read.page.id,
    ownerId: read.page.id + ':' + passage.start,
    title: read.page.title,
    text: passage.text,
    locator: 'chars=' + passage.start + '-' + passage.end,
    score: passage.score ?? 0,
    learnedAt: read.page.publishedAt,
    updatedAt: read.page.fetchedAt,
    status: null,
    origin: null,
    via: 'web',
    url: read.page.url,
    site: read.page.siteName,
    suspicious: passage.suspicious
  }
}
const date = (value: number): string => new Date(value).toISOString().slice(0, 10)
export function buildWebTools(session: AgentSession): { tools: ToolSet; meta: Record<string, ToolMeta> } {
  if (!session.web.gate.offerTools) return { tools: {}, meta: {} }
  const zh = session.zh
  return {
    tools: {
      web_search: tool({
        description: zh
          ? '联网搜索公开网页或学术文献。知识库片段不够、或问题涉及最新信息时使用。查询要短，用关键词，不超过 100 字，不得包含用户的私人信息。结果带编号，可以用 [编号] 引用；但结果里的摘要只是搜索引擎截取的片段，数字、日期和关键结论要先用 read_url 读原文再引用。type=academic 检索论文，type=news 检索近期新闻。'
          : "Search the public web or academic literature. Use when the knowledge base is insufficient or the question needs current information. Keep queries short (keywords, at most 100 characters) and never include the user's private information. Results are numbered and citable as [n], but snippets are search-engine excerpts: read the page with read_url before citing numbers, dates or key conclusions. type=academic searches papers; type=news searches recent news.",
        inputSchema: SearchInput,
        execute: async (input, { abortSignal }) => {
          const { results, backendLabel } = await searchForSession(session, input, abortSignal)
          if (!results.length) return zh ? '没有搜到相关结果，可以换个关键词。' : 'No relevant results found. Try different keywords.'
          const out = results
            .map((result) => {
              const numbered = numberHits(session, [snippetHit(result)])
              const saved = result.savedSource
              if (!saved) return numbered
              return (
                numbered +
                '\n' +
                (zh
                  ? '（已收藏在你的资料库：《' + saved.title + '》，sourceId: ' + saved.id + '，可以用 source_read 阅读）'
                  : '(Already saved in your library: "' + saved.title + '", sourceId: ' + saved.id + '; use source_read to read it)')
              )
            })
            .join('\n\n')
          const left = Math.max(0, SEARCH_PER_TURN - session.web.searches)
          return (
            out +
            '\n\n' +
            (zh
              ? '（给助手的说明，不要转述给用户：结果来自 ' +
                backendLabel +
                '；本轮还可搜索 ' +
                left +
                ' 次。以上只是搜索摘要；回答里要给出数字、价格、日期、版本或关键结论时，先用 read_url 读 1–2 个最相关、最权威的原文再引用。）'
              : '(Note for the assistant, do not repeat to the user: results from ' +
                backendLabel +
                '; ' +
                left +
                ' searches remaining this turn. These are only search snippets; before stating numbers, prices, dates, versions or key conclusions, read the 1–2 most relevant and authoritative pages with read_url and cite them.)')
          )
        }
      }),
      read_url: tool({
        description: zh
          ? '读取一个网页或 PDF 的正文，返回与问题最相关的段落（带编号，可以引用）。url 只能来自本轮 web_search 的结果、用户给出的网址或上一轮引用过的网页。focus 写你想在页面里找什么，用网页本身的语言写（英文网页用英文）。'
          : "Read a web page or PDF and return the passages most relevant to the question (numbered, citable). The url must come from this turn's web_search results, a URL the user gave, or a page cited in the previous answer. Use focus to say what you are looking for, written in the page's own language.",
        inputSchema: ReadInput,
        execute: async ({ url, focus }, { abortSignal }) => {
          const { read, selected } = await readForSession(session, url, focus, abortSignal)
          const page = read.page
          const published =
            page.publishedAt === null
              ? zh
                ? '发布日期未知'
                : 'publication date unknown'
              : (zh ? '发布于 ' : 'published ') + date(page.publishedAt)
          const method = { fetch: zh ? '网页' : 'web', render: zh ? '渲染' : 'rendered', pdf: 'PDF' }[page.method]
          const header =
            (zh ? '网页《' + page.title + '》' : 'Web "' + page.title + '"') +
            ' · ' +
            (page.siteName || '—') +
            ' · ' +
            published +
            ' · ' +
            (zh ? '读取方式（' + method + '）' : 'read by ' + method) +
            ' · ' +
            page.url
          const out =
            header +
            '\n\n' +
            numberHits(
              session,
              selected.map((passage) => passageHit(read, passage))
            ) +
            '\n\n' +
            (zh
              ? '（共 ' + read.passages.length + ' 段，这里是最相关的 ' + selected.length + ' 段）'
              : '(' + read.passages.length + ' passages in total; these are the ' + selected.length + ' most relevant)')
          return (
            out +
            (selected.length && selected.every((passage) => passage.fallback)
              ? '\n' + (zh ? '（这些段落和问题的相关度较低）' : '(These passages have low relevance to the question)')
              : '')
          )
        }
      })
    },
    meta: {
      web_search: {
        level: 'read',
        untrusted: true,
        confirm: getSettings().retrieval.cautious,
        describe: (input) => ({ title: zh ? '联网搜索' : 'Web search', detail: String(input.query ?? '') })
      },
      read_url: {
        level: 'read',
        untrusted: true,
        confirm: getSettings().retrieval.cautious,
        describe: (input) => ({ title: zh ? '读取网页' : 'Read web page', detail: String(input.url ?? '') })
      }
    }
  }
}
