import { ACADEMIC_BACKENDS, type BackendId, type WebResult } from '@shared/retrieval'
import type { SearchHit } from '@shared/types'
import type { Passage, ReadPage } from './reader'
import { embed, isReady } from '../ai/embedding'
import { weight } from '../ai/retrieve'
import { getSettings } from '../settings'
import { urlKey } from './backends/normalize'

export const TUNING = {
  // P6固定原创语料+本地EmbeddingGemma校准；选择规则和局限见web-eval与架构第48节。
  REL: 0.65,
  // 知识库片段的入选下限：按加权分计，已过时（×0.55）的旧笔记仍要能入选，才能讲清“你笔记写的是 X”。
  FLOOR: 0.4,
  // 网页段落的入选下限：校准语料里不相关段落 180 个全部高于 0.40、金标准最低 0.64、相关最低 0.595，
  // 0.50 约能去掉一成五的不相关段落且不碰相关段落（Claude 审查 2026-10-14）。
  WEB_FLOOR: 0.5,
  SLOTS: 12,
  KB_MIN: 3,
  WEB_MIN: 3,
  PER_PAGE: 2,
  PER_PARENT: 3,
  HALF_LIFE_DAYS: 90,
  FRESH_MIN: 0.5,
  FRESH_UNKNOWN: 0.8
} as const

export interface ScoredKb {
  hit: SearchHit
  score: number
  /** 评分降级为归一化 RRF；分配时适用 0.2 下限。 */
  fallback?: boolean
}

export interface WebCandidate {
  pageId: string
  url: string
  title: string
  text: string
  site?: string | null
  publishedAt: number | null
  fetchedAt: number
  start?: number
  end?: number
  snippetOnly?: boolean
  suspicious?: boolean
  backend?: BackendId
  meta?: Pick<WebResult, 'authors' | 'year' | 'venue' | 'citations' | 'doi' | 'pdfUrl'>
}

export interface ScoredWeb {
  hit: WebCandidate
  score: number
  /** 评分降级为词法相关度；分配时适用 0.2 下限，不表示强制选取低相关段落。 */
  fallback?: boolean
}

export function coverage(hits: SearchHit[]): 'enough' | 'partial' | 'none' {
  if (!hits.length) return 'none'
  const semantic = hits.filter((hit) => finite(hit.sim))
  if (!semantic.length) return 'partial'
  const relevant = semantic.filter((hit) => hit.sim! >= TUNING.REL).length
  return relevant >= 2 ? 'enough' : relevant === 1 ? 'partial' : 'none'
}

const AUTHORITATIVE_SUFFIXES = ['.gov', '.gov.cn', '.edu', '.edu.cn', '.ac.cn', '.ac.uk', '.mil']
const AUTHORITATIVE_SITES = [
  'who.int',
  'un.org',
  'europa.eu',
  'nature.com',
  'science.org',
  'cell.com',
  'thelancet.com',
  'nejm.org',
  'springer.com',
  'sciencedirect.com',
  'wiley.com',
  'ieee.org',
  'acm.org',
  'arxiv.org',
  'cnki.net',
  'doi.org'
]
const EDITORIAL_SITES = [
  'wikipedia.org',
  'xinhuanet.com',
  'news.cn',
  'people.com.cn',
  'cctv.com',
  'thepaper.cn',
  'caixin.com',
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'bbc.co.uk',
  'nytimes.com',
  'ft.com',
  'economist.com',
  'wsj.com',
  'bloomberg.com'
]
const SELF_PUBLISHING_SITES = [
  'medium.com',
  'substack.com',
  'blogspot.com',
  'wordpress.com',
  'jianshu.com',
  'csdn.net',
  'cnblogs.com',
  'juejin.cn',
  'toutiao.com',
  'baijiahao.baidu.com',
  'mp.weixin.qq.com',
  'zhuanlan.zhihu.com'
]

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '')
}

/** 完整域名或带点的子域名边界；不把 lookalike 域名当作可信站点。 */
function domainMatches(host: string, domain: string): boolean {
  const normalized = normalizeDomain(domain)
  return !!normalized && (host === normalized || host.endsWith(`.${normalized}`))
}

export function authorityOf(url: string, backend?: BackendId): number {
  let parsed: URL
  try {
    parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return 0.9
  } catch {
    return 0.9
  }
  const host = normalizeDomain(parsed.hostname)
  const settings = getSettings().retrieval
  if (settings.lowTrustSites.some((domain) => domainMatches(host, domain))) return 0.5
  if (settings.trustedSites.some((domain) => domainMatches(host, domain))) return 1.2
  if (ACADEMIC_BACKENDS.some((academic) => academic === backend)) return 1.2
  if (AUTHORITATIVE_SUFFIXES.some((suffix) => host.endsWith(suffix)) || AUTHORITATIVE_SITES.some((domain) => domainMatches(host, domain)))
    return 1.2
  if (EDITORIAL_SITES.some((domain) => domainMatches(host, domain))) return 1
  if (SELF_PUBLISHING_SITES.some((domain) => domainMatches(host, domain))) return 0.8
  if (domainMatches(host, 'sohu.com') && parsed.pathname.startsWith('/a/')) return 0.8
  if (domainMatches(host, '163.com') && parsed.pathname.startsWith('/dy/')) return 0.8
  return 0.9
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function fresh(publishedAt: number | null, timeSensitive: boolean): number {
  if (!timeSensitive) return 1
  if (!finite(publishedAt)) return TUNING.FRESH_UNKNOWN
  const ageDays = (Date.now() - publishedAt) / 86_400_000
  return Math.max(TUNING.FRESH_MIN, 0.5 ** (ageDays / TUNING.HALF_LIFE_DAYS))
}

function lexicalTokens(text: string): Set<string> {
  const lower = text.toLowerCase()
  const han = lower.match(/\p{Script=Han}+/gu)
  if (han) {
    const tokens = new Set<string>()
    for (const run of han) {
      const chars = Array.from(run)
      for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1])
    }
    return tokens
  }
  return new Set((lower.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => Array.from(word).length >= 2))
}

/** 查询和段落各自分词；含 Han 的字符串只取连续 Han 二元组，不跨空白或其他文字拼接。 */
export function lexical(query: string, text: string): number {
  const queryTokens = lexicalTokens(query)
  if (!queryTokens.size) return 0
  const textTokens = lexicalTokens(text)
  let overlap = 0
  for (const token of queryTokens) if (textTokens.has(token)) overlap++
  return overlap / queryTokens.size
}

export function scoreKb(hits: SearchHit[], prefer?: string | null): ScoredKb[] {
  const maxScore = hits.reduce((max, hit) => (finite(hit.score) ? Math.max(max, hit.score) : max), 0)
  return hits.map((hit) => {
    const fallback = !finite(hit.sim)
    const sim = fallback ? (maxScore > 0 && finite(hit.score) ? Math.max(0, Math.min(1, hit.score / maxScore)) : 0) : hit.sim!
    return { hit, score: sim * weight(hit) * (hit.parentId === prefer ? 1.6 : 1), fallback }
  })
}

function validVector(vector: unknown, dimensions?: number): vector is number[] {
  return Array.isArray(vector) && vector.length > 0 && (dimensions === undefined || vector.length === dimensions) && vector.every(finite)
}

/** 一次查询向量、一次文档批量。失败或格式不完整时整批退回词法，不记录查询或服务商错误内容。 */
async function semanticSimilarities(hits: WebCandidate[], query: string, beforeSend?: () => void): Promise<number[] | null> {
  let guardRejected = false
  const assertAllowed = () => {
    try {
      beforeSend?.()
    } catch (error) {
      guardRejected = true
      throw error
    }
  }
  try {
    assertAllowed()
    if (!(await isReady())) return null
    assertAllowed()
    const queryVectors = beforeSend ? await embed([query], 'query', undefined, assertAllowed) : await embed([query], 'query')
    assertAllowed()
    if (!Array.isArray(queryVectors) || queryVectors.length !== 1 || !validVector(queryVectors[0])) return null
    const vector = queryVectors[0]
    const texts = hits.map((hit) => hit.text)
    const titles = hits.map((hit) => hit.title)
    const documents = beforeSend ? await embed(texts, 'doc', titles, assertAllowed) : await embed(texts, 'doc', titles)
    assertAllowed()
    if (!Array.isArray(documents) || documents.length !== hits.length || !documents.every((doc) => validVector(doc, vector.length)))
      return null
    const scores = documents.map((doc) => doc.reduce((sum, value, i) => sum + value * vector[i], 0))
    return scores.every(finite) ? scores : null
  } catch (error) {
    // 隐私拒绝不能被当作向量服务故障，否则词法退路仍会把已禁用内容交给模型。
    if (guardRejected) throw error
    assertAllowed()
    return null
  }
}

export async function scoreWeb(
  hits: WebCandidate[],
  query: string,
  opts: { timeSensitive: boolean; beforeSend?: () => void }
): Promise<ScoredWeb[]> {
  if (!hits.length) return []
  const similarities = await semanticSimilarities(hits, query, opts.beforeSend)
  opts.beforeSend?.()
  return hits.map((hit, i) => ({
    hit,
    score:
      (similarities ? similarities[i] : lexical(query, hit.text)) *
      authorityOf(hit.url, hit.backend) *
      fresh(hit.publishedAt, opts.timeSensitive),
    fallback: similarities === null
  }))
}

function floor(fallback?: boolean, web = false): number {
  return fallback ? 0.2 : web ? TUNING.WEB_FLOOR : TUNING.FLOOR
}

function positiveCount(value: number): number {
  return finite(value) ? Math.max(0, Math.floor(value)) : 0
}

function ranked<T extends { score: number; fallback?: boolean }>(hits: T[], limit: number, keyOf: (hit: T) => string, web = false): T[] {
  const count = new Map<string, number>()
  return hits
    .filter((hit) => finite(hit.score) && hit.score >= floor(hit.fallback, web))
    .sort((a, b) => b.score - a.score)
    .filter((hit) => {
      const key = keyOf(hit)
      const used = count.get(key) ?? 0
      if (used >= limit) return false
      count.set(key, used + 1)
      return true
    })
}

export function allocate(kb: ScoredKb[], web: ScoredWeb[], slots: number = TUNING.SLOTS): { kb: ScoredKb[]; web: ScoredWeb[] } {
  const result: { kb: ScoredKb[]; web: ScoredWeb[] } = { kb: [], web: [] }
  const total = positiveCount(slots)
  if (!total) return result
  const kbQueue = ranked(kb, TUNING.PER_PARENT, (entry) => entry.hit.parentId)
  const webQueue = ranked(
    web,
    TUNING.PER_PAGE,
    (entry) => (entry.hit.pageId.trim() ? `id:${entry.hit.pageId}` : `url:${urlKey(entry.hit.url) ?? entry.hit.url}`),
    true
  )
  let kbIndex = 0,
    webIndex = 0
  if (kbQueue.length && webQueue.length) {
    const kbMin = Math.min(TUNING.KB_MIN, kbQueue.length),
      webMin = Math.min(TUNING.WEB_MIN, webQueue.length)
    // 自定义名额小于两边保底之和时交替保留，最高分的一边先取，仍严格遵守总上限。
    let preferKb = kbQueue[0].score >= webQueue[0].score
    while (kbIndex + webIndex < total && (kbIndex < kbMin || webIndex < webMin)) {
      if (kbIndex < kbMin && (preferKb || webIndex >= webMin)) result.kb.push(kbQueue[kbIndex++])
      else result.web.push(webQueue[webIndex++])
      preferKb = !preferKb
    }
  }
  while (kbIndex + webIndex < total && (kbIndex < kbQueue.length || webIndex < webQueue.length)) {
    if (kbIndex < kbQueue.length && (webIndex >= webQueue.length || kbQueue[kbIndex].score >= webQueue[webIndex].score))
      result.kb.push(kbQueue[kbIndex++])
    else result.web.push(webQueue[webIndex++])
  }
  return result
}

/** 返回的 fallback 专指无合格段落时强制选取低相关段落；合格的词法评分段落仍为 false。 */
export async function selectPassages(
  read: ReadPage,
  query: string,
  opts: { timeSensitive: boolean; k?: number; beforeSend?: () => void }
): Promise<(Passage & { score: number; fallback: boolean })[]> {
  const k = positiveCount(opts.k ?? 6)
  if (!k || !read.passages.length) return []
  const scored = await scoreWeb(
    read.passages.map((passage) => ({
      pageId: read.page.id,
      url: read.page.url,
      title: read.page.title,
      text: passage.text,
      site: read.page.siteName,
      publishedAt: read.page.publishedAt,
      fetchedAt: read.page.fetchedAt
    })),
    query,
    opts
  )
  const ordered = scored.map((entry, position) => ({ entry, position })).sort((a, b) => b.entry.score - a.entry.score)
  const qualified = ordered.filter(({ entry }) => entry.score >= floor(entry.fallback, true))
  const fallback = !qualified.length
  const selected = fallback ? ordered.slice(0, Math.min(3, k)) : qualified.slice(0, k)
  return selected
    .sort((a, b) => a.position - b.position)
    .map(({ entry, position }) => ({
      ...read.passages[position],
      score: entry.score,
      fallback
    }))
}
