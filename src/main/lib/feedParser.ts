import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { parseHTML } from 'linkedom'
import type { Feed } from '@shared/discover'

export interface ParsedItem {
  url: string
  title: string
  summary: string
  author: string | null
  publishedAt: number | null
  audioUrl: string | null
  pdfUrl: string | null
}
const array = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v)
    : v && typeof v === 'object'
      ? text((v as Record<string, unknown>)['#text'])
      : ''
export function plainFeedText(v: unknown, max = 4000): string {
  const { document } = parseHTML(`<html><body>${text(v)}</body></html>`)
  document.querySelectorAll('script,style').forEach((n) => n.remove())
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}
export function canonicalItemUrl(value: string, base?: string): string | null {
  try {
    const u = new URL(value, base)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return null
    u.hash = ''
    return u.href
  } catch {
    return null
  }
}
export function arxivPdf(url: string): string | null {
  const u = new URL(url)
  return /^(www\.)?arxiv\.org$/.test(u.hostname) && /^\/abs\/[a-z\d./-]+$/i.test(u.pathname)
    ? `https://arxiv.org/pdf/${u.pathname.slice(5)}`
    : null
}
export function normalizeFeed(value: string, kind?: Feed['kind']): { kind: Feed['kind']; url: string } {
  const v = value.trim()
  if ((kind === 'arxiv' || !kind) && /^[a-z-]+(?:\.[A-Z]{2})?$/.test(v)) return { kind: 'arxiv', url: `https://rss.arxiv.org/rss/${v}` }
  if ((kind === 'youtube' || !kind) && /^UC[\w-]{22}$/.test(v))
    return { kind: 'youtube', url: `https://www.youtube.com/feeds/videos.xml?channel_id=${v}` }
  const url = canonicalItemUrl(v)
  if (!url) throw new Error('Invalid feed address')
  const u = new URL(url)
  if (/(^|\.)youtube\.com$/.test(u.hostname)) {
    const id = /^\/channel\/(UC[\w-]{22})/.exec(u.pathname)?.[1] ?? u.searchParams.get('channel_id')
    if (id) return { kind: 'youtube', url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}` }
    return { kind: 'youtube', url }
  }
  return { kind: kind ?? (/rss\.arxiv\.org$/.test(u.hostname) ? 'arxiv' : 'rss'), url }
}

export function parseFeed(xml: string, base: string): { title: string; kind: 'rss' | 'atom'; items: ParsedItem[] } {
  // 不展开自定义实体，防止订阅内容把一个小响应膨胀成无界内存。
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid feed XML')
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true }).parse(xml)
  const root = parsed.rss?.channel ?? parsed.feed ?? parsed.RDF,
    kind = parsed.feed ? 'atom' : 'rss'
  if (!root) throw new Error('RSS or Atom feed required')
  const entries = array<Record<string, unknown>>(kind === 'atom' ? root.entry : (root.item ?? parsed.RDF?.item)),
    items: ParsedItem[] = [],
    seen = new Set<string>()
  for (const e of entries) {
    const links = array(e.link) as (string | Record<string, string>)[]
    const alternate = links.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'))
    const link = typeof alternate === 'object' ? alternate['@_href'] : text(e.link) || text(e.id)
    const url = link ? canonicalItemUrl(link, base) : null
    if (!url || seen.has(url)) continue
    const encl = array(e.enclosure) as Record<string, string>[],
      audio =
        encl.find((l) => l['@_type']?.startsWith('audio/')) ??
        (links.find((l) => typeof l === 'object' && l['@_rel'] === 'enclosure' && l['@_type']?.startsWith('audio/')) as
          Record<string, string> | undefined),
      pdf = links.find((l) => typeof l === 'object' && l['@_type'] === 'application/pdf') as Record<string, string> | undefined,
      author =
        array(e.author)
          .map((a) => (typeof a === 'object' ? text((a as Record<string, unknown>).name) : text(a)))
          .filter(Boolean)
          .join(', ') || text(e.creator),
      date = Date.parse(text(e.published) || text(e.pubDate) || text(e.updated) || text(e.date)),
      group = e.group as Record<string, unknown> | undefined
    items.push({
      url,
      title: plainFeedText(e.title, 500) || url,
      summary: plainFeedText(e.summary ?? e.description ?? e.encoded ?? e.content ?? group?.description),
      author: author.slice(0, 500) || null,
      publishedAt: Number.isFinite(date) ? date : null,
      audioUrl: audio ? canonicalItemUrl(audio['@_url'] ?? audio['@_href'], base) : null,
      pdfUrl: pdf ? canonicalItemUrl(pdf['@_href'], base) : arxivPdf(url)
    })
    seen.add(url)
  }
  items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
  return { title: plainFeedText(root.title, 200) || new URL(base).hostname, kind, items: items.slice(0, 30) }
}
