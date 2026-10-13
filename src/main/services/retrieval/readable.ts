import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { readingHtmlText } from '../../lib/reading'
import { plainFeedText } from '../../lib/feedParser'

export interface ReadablePage {
  title: string
  siteName: string
  publishedAt: number | null
  lang: string | null
  text: string
}
const suspicious = [
  /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions|prompts?)/i,
  /(you are now|act as|new instructions?|system prompt)/i,
  /(忽略|无视|忘记)(以上|之前|前面|上述)(的)?(所有)?(指令|提示|要求)/,
  /(你现在是|从现在起你|新的指令|系统提示词)/,
  /(发送|上传|转发).{0,10}(笔记|资料|聊天记录|密钥|key)/i
]
export const isSuspicious = (text: string): boolean => suspicious.some((pattern) => pattern.test(text))
const cleanText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff\u2060]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
const blocks = new Set([
  'ADDRESS',
  'ARTICLE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TFOOT',
  'THEAD',
  'TR',
  'UL'
])
const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function paragraphText(html: string): string {
  const { document } = parseHTML('<html><body>' + html + '</body></html>')
  const output: string[] = []
  let inline = ''
  const flush = (): void => {
    // FEFF 会被现有 helper 的空白折叠变成空格，须先删除零宽字符以保留词内连接。
    const text = readingHtmlText('<html><body>' + inline.replace(/[\u200b-\u200d\ufeff\u2060]/g, '') + '</body></html>')
    if (text) output.push(text)
    inline = ''
  }
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      inline += escapeText(node.textContent ?? '')
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    if (blocks.has(element.nodeName)) {
      flush()
      for (const child of Array.from(element.childNodes)) visit(child)
      flush()
    } else inline += element.outerHTML
  }
  for (const node of Array.from(document.body.childNodes)) visit(node)
  flush()
  return cleanText(output.join('\n\n'))
}
export function extractReadable(html: string, url: string): ReadablePage {
  const { document } = parseHTML(html)
  document
    .querySelectorAll(
      'script,style,noscript,template,svg,iframe,canvas,form,nav,footer,aside,[hidden],[aria-hidden="true"],[data-jiwei-ui]'
    )
    .forEach((node) => node.remove())
  document.querySelectorAll('[style]').forEach((node) => {
    const style = (node.getAttribute('style') ?? '').replace(/\s/g, '').toLowerCase()
    if (
      /display:none|visibility:hidden|font-size:0(?:\.0+)?(?:px|em|rem|pt|%|cm|mm|in|pc|ex|ch|vh|vw|vmin|vmax)?(?:!important)?(?:;|$)/.test(
        style
      )
    )
      node.remove()
  })
  const metas = (selector: string): string[] =>
    Array.from(document.querySelectorAll(selector), (node) => node.getAttribute('content') ?? '')
  const ogTitle = metas('meta[property="og:title"]')[0]
  const siteName = metas('meta[property="og:site_name"]')[0]
  const documentTitle = document.querySelector('title')?.textContent ?? ''
  const lang = document.documentElement.getAttribute('lang')?.trim() || null
  const dates = [
    ...metas('meta[property="article:published_time"]'),
    ...metas('meta[name="pubdate"]'),
    ...metas('meta[name="publishdate"]'),
    ...metas('meta[name="date"]'),
    document.querySelector('time[datetime]')?.getAttribute('datetime') ?? ''
  ]
  const fallback = document.body.innerHTML
  const article = new Readability(document as unknown as Document).parse()
  dates.push(article?.publishedTime ?? '')
  let publishedAt: number | null = null
  for (const value of dates) {
    const at = Date.parse(value)
    if (Number.isFinite(at) && at <= Date.now() + 86400000) {
      publishedAt = at
      break
    }
  }
  const title = [ogTitle, article?.title, documentTitle].map((value) => cleanText(plainFeedText(value, 500))).find(Boolean) ?? ''
  return {
    title,
    siteName: cleanText(plainFeedText(siteName, 300)) || new URL(url).hostname,
    publishedAt,
    lang,
    text: paragraphText(article?.content || fallback)
  }
}
