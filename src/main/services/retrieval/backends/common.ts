import { app } from 'electron'
import type { BackendId, Freshness, SearchType, WebResult } from '@shared/retrieval'
import { checkedWebUrl, externalFetch } from '../../externalFetch'
import { getSettings } from '../../settings'
import { plainFeedText } from '../../../lib/feedParser'
import { isSensitiveUrl } from '../../../lib/browserPolicy'
import { canonicalUrl } from './normalize'

export interface BackendQuery {
  q: string
  type: SearchType
  freshness?: Freshness
  site?: string
  count: number
  lang: 'zh' | 'en'
}
export interface SearchBackend {
  id: BackendId
  search(query: BackendQuery, cred: { key: string | null; baseUrl: string | null }, signal: AbortSignal): Promise<WebResult[]>
}
export class BackendError extends Error {
  readonly status?: number
  readonly retryable: boolean
  constructor(options: { retryable: boolean; status?: number; kind?: 'http' | 'network' | 'parse' | 'configuration' | 'service' }) {
    // 不接收原始错误消息：服务响应与网络错误都可能包含 Key 或查询。
    super('Search backend failed (' + (options.kind ?? 'service') + (options.status === undefined ? '' : ', ' + options.status) + ')')
    this.name = 'BackendError'
    this.status = options.status
    this.retryable = options.retryable
  }
}
export type JsonRecord = Record<string, unknown>
export const recency = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' } as const
export const withSite = (query: BackendQuery): string => query.q + (query.site ? ' site:' + query.site : '')

export function requiredKey(key: string | null): string {
  if (!key?.trim()) throw new BackendError({ kind: 'configuration', retryable: false })
  return key
}
function endpoint(id: BackendId, value: string, suffix = ''): URL {
  try {
    const original = checkedWebUrl(value)
    const base = process.env.JIWEI_SEARCH_BASE
    if (app.isPackaged || !base) return original
    const url = checkedWebUrl(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash) throw new Error()
    url.pathname = url.pathname.replace(/\/+$/, '') + '/' + id + suffix
    url.search = original.search
    return url
  } catch {
    throw new BackendError({ kind: 'configuration', retryable: false })
  }
}
type Response = Awaited<ReturnType<typeof externalFetch>>
export async function request(
  id: BackendId,
  value: string,
  signal: AbortSignal,
  options: Omit<NonNullable<Parameters<typeof externalFetch>[1]>, 'signal' | 'validateUrl'> & { fixtureSuffix?: string } = {}
): Promise<Response> {
  const { fixtureSuffix, ...fetchOptions } = options
  const url = endpoint(id, value, fixtureSuffix)
  try {
    return await externalFetch(url.href, {
      ...fetchOptions,
      signal,
      httpsOnly: options.httpsOnly ?? true,
      validateUrl: (next) => {
        try {
          if (checkedWebUrl(next, options.httpsOnly ?? true).origin !== url.origin) throw new Error()
        } catch {
          throw new BackendError({ kind: 'configuration', retryable: false })
        }
      }
    })
  } catch (error) {
    if (error instanceof BackendError) throw error
    throw new BackendError({ kind: 'network', retryable: true })
  }
}
export function assertStatus(response: Pick<Response, 'status'>): void {
  if (response.status !== 200)
    throw new BackendError({
      kind: 'http',
      status: response.status,
      retryable: response.status === 429 || (response.status >= 500 && response.status < 600)
    })
}
export function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackendError({ kind: 'parse', retryable: false })
  return value as JsonRecord
}
export function optionalRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}
export function rows(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw new BackendError({ kind: 'parse', retryable: false })
  return value.map(record)
}
export function parseJson(text: string): JsonRecord {
  try {
    return record(JSON.parse(text))
  } catch {
    throw new BackendError({ kind: 'parse', retryable: false })
  }
}
export function jsonResponse(response: Response): JsonRecord {
  assertStatus(response)
  return parseJson(response.text)
}
export interface ResultFields {
  url: unknown
  title?: unknown
  snippet?: unknown
  published?: unknown
  site?: unknown
  content?: unknown
  doi?: unknown
  authors?: unknown
  year?: unknown
  venue?: unknown
  citations?: unknown
  pdfUrl?: unknown
}
export function doiValue(value: unknown): string | undefined {
  const doi = typeof value === 'string' ? plainFeedText(value, 300).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') : ''
  return doi || undefined
}
export function doiUrl(value: unknown): string | undefined {
  const doi = doiValue(value)
  return doi ? 'https://doi.org/' + doi : undefined
}
export function normalizeResults(id: BackendId, values: ResultFields[], count: number): WebResult[] {
  const blocked = getSettings().browser?.aiBlockedSites ?? []
  const allowed = (value: unknown): string | null => {
    const url = typeof value === 'string' ? canonicalUrl(value) : null
    return url && !isSensitiveUrl(url, blocked) ? url : null
  }
  const results: WebResult[] = []
  for (const value of values) {
    const url = allowed(value.url)
    if (!url) continue
    const result: WebResult = {
      url,
      title: plainFeedText(value.title, 300) || new URL(url).hostname,
      snippet: plainFeedText(value.snippet, 600),
      backend: id,
      rank: results.length + 1
    }
    const date = typeof value.published === 'string' ? Date.parse(value.published) : NaN
    if (Number.isFinite(date)) result.publishedAt = date
    const site = plainFeedText(value.site, 300)
    if (site) result.site = site
    if (typeof value.content === 'string') result.content = plainFeedText(value.content, 8000)
    const doi = doiValue(value.doi)
    if (doi) result.doi = doi
    if (Array.isArray(value.authors)) {
      const authors = value.authors
        .filter((v): v is string => typeof v === 'string')
        .map((v) => plainFeedText(v, 300))
        .filter(Boolean)
        .slice(0, 6)
      if (authors.length) result.authors = authors
    }
    if (typeof value.year === 'number' && Number.isInteger(value.year)) result.year = value.year
    const venue = plainFeedText(value.venue, 300)
    if (venue) result.venue = venue
    if (typeof value.citations === 'number' && Number.isFinite(value.citations) && value.citations >= 0) result.citations = value.citations
    const pdf = allowed(value.pdfUrl)
    if (pdf) result.pdfUrl = pdf
    results.push(result)
    if (results.length >= count) break
  }
  return results
}
