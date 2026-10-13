import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import type { WebPageView } from '@shared/retrieval'
import type { PdfParse } from '../../../worker/parsers'
import { getDb } from '../../db'
import { webPages } from '../../db/schema'
import { newId } from '../../lib/ids'
import { tr } from '../../lib/messages'
import { segmentText } from '../../lib/segment'
import { checkBudget } from '../agent/usage'
import { externalFetch } from '../externalFetch'
import { runInWorker } from '../jobs'
import { saveWebPage } from '../sources'
import { canonicalUrl } from './backends/normalize'
import { assertWebAllowed } from './policy'
import { recordCall, reserveCall } from './calls'
import { assertReadableUrl, PagePolicyError } from './pagePolicy'
import { extractReadable, isSuspicious, type ReadablePage } from './readable'
import { renderPage } from './render'

export interface Passage {
  index: number
  start: number
  end: number
  text: string
  suspicious: boolean
}
export interface ReadPage {
  page: WebPageView
  passages: Passage[]
}
export interface ReadOptions {
  signal?: AbortSignal
  incognito?: boolean
  validateUrl?: (url: string) => void
}
type PageRow = typeof webPages.$inferSelect
type Snapshot = Omit<PageRow, 'id'>
const temporary = new Map<string, WebPageView>()
const messages = {
  invalid: ['网址无效', 'Invalid address'],
  canceled: ['读取已取消', 'Reading canceled'],
  scope: ['这个网址不在允许读取的范围内', 'This address is outside the allowed reading scope'],
  failed: ['网页读取失败，请稍后再试', 'Page reading failed. Try again later'],
  unsupported: ['暂不支持读取这种类型的内容', 'This content type cannot be read yet'],
  empty: ['这个网页没有可读的正文（可能需要登录）', 'This page has no readable text (it may require a login)'],
  scanned: ['这是扫描版 PDF，暂时读不出文字', 'This is a scanned PDF; its text cannot be read yet'],
  size: ['网页或文件过大，暂时无法读取', 'This page or file is too large to read'],
  expired: ['网页快照已失效', 'The page snapshot is no longer available']
} as const
class ReadError extends Error {
  constructor(reason: keyof typeof messages) {
    const m = messages[reason]
    super(tr(m[0], m[1]))
    this.name = 'ReadError'
  }
}
const toView = (row: PageRow | (Snapshot & { id: string })): WebPageView => ({
  id: row.id,
  url: row.url,
  title: row.title,
  siteName: row.siteName,
  publishedAt: row.publishedAt,
  fetchedAt: row.fetchedAt,
  method: row.method,
  text: row.text
})
function remember(page: WebPageView): WebPageView {
  const copy = { ...page, id: 'tmp-' + newId() }
  temporary.set(copy.id, { ...copy })
  while (temporary.size > 50) {
    const oldest = temporary.keys().next().value
    if (oldest !== undefined) temporary.delete(oldest)
  }
  return copy
}
export function getPage(id: string): WebPageView | null {
  if (id.startsWith('tmp-')) return temporary.has(id) ? { ...temporary.get(id)! } : null
  const row = getDb().select().from(webPages).where(eq(webPages.id, id)).get()
  return row ? toView(row) : null
}
const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
export async function savePage(id: string): Promise<{ sourceId: string }> {
  const page = getPage(id)
  if (!page) throw new ReadError('expired')
  const html =
    '<!doctype html><html><head><title>' +
    escapeHtml(page.title) +
    '</title></head><body>' +
    page.text
      .split('\n\n')
      .map((text) => '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>')
      .join('') +
    '</body></html>'
  const source = await saveWebPage({ url: page.url, title: page.title, html })
  return { sourceId: source.id }
}
function passages(text: string): Passage[] {
  const pieces = segmentText(text, 'plain').map((segment) => {
    let start = segment.locator.start,
      end = segment.locator.end
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    return { start, end, text: text.slice(start, end) }
  })
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].text.length >= 20) continue
    if (i + 1 < pieces.length) {
      pieces[i + 1] = { start: pieces[i].start, end: pieces[i + 1].end, text: text.slice(pieces[i].start, pieces[i + 1].end) }
      pieces.splice(i--, 1)
    } else if (i > 0) {
      // 末段没有下一段，合并到前段，不能把来源信息静默丢掉。
      pieces[i - 1] = { start: pieces[i - 1].start, end: pieces[i].end, text: text.slice(pieces[i - 1].start, pieces[i].end) }
      pieces.splice(i, 1)
    }
  }
  return pieces.map((piece, index) => ({ ...piece, index, suspicious: isSuspicious(piece.text) }))
}
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const canceled = (): void => {
      cleanup()
      reject(new ReadError('canceled'))
    }
    const cleanup = (): void => signal.removeEventListener('abort', canceled)
    signal.addEventListener('abort', canceled, { once: true })
    promise.then(
      (value) => {
        cleanup()
        if (signal.aborted) reject(new ReadError('canceled'))
        else resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) canceled()
  })
}
function persist(snapshot: Snapshot): WebPageView {
  const db = getDb()
  return db.transaction(() => {
    const condition = and(eq(webPages.url, snapshot.url), eq(webPages.textHash, snapshot.textHash))
    const existing = db.select().from(webPages).where(condition).get()
    if (existing) {
      assertReadableUrl(existing.finalUrl)
      db.update(webPages).set({ fetchedAt: snapshot.fetchedAt }).where(eq(webPages.id, existing.id)).run()
      return toView({ ...existing, fetchedAt: snapshot.fetchedAt })
    }
    const row: PageRow = { ...snapshot, id: newId() }
    db.insert(webPages).values(row).run()
    return toView(row)
  })
}
async function parsePdf(bytes: Uint8Array, url: string, signal?: AbortSignal): Promise<ReadablePage> {
  const path = join(app.getPath('temp'), 'jiwei-reader-' + randomUUID() + '.pdf')
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.close()
    const result = await withAbort(runInWorker<PdfParse>('parsePdf', { path }, undefined, signal), signal)
    const text = result.segments
      .map((segment) => segment.text)
      .join('\n\n')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u200b-\u200d\ufeff\u2060]/g, '')
      .trim()
    if (text.length < 200) throw new ReadError('scanned')
    return {
      title: result.segments[0]?.text.trim().slice(0, 80) || new URL(url).pathname.split('/').at(-1) || new URL(url).hostname,
      siteName: new URL(url).hostname,
      publishedAt: null,
      lang: null,
      text
    }
  } finally {
    await file.close().catch(() => {})
    await unlink(path)
  }
}
export async function readUrl(value: string, opts: ReadOptions = {}): Promise<ReadPage> {
  assertWebAllowed()
  checkBudget()
  if (opts.signal?.aborted) throw new ReadError('canceled')
  const url = canonicalUrl(value)
  if (!url) throw new ReadError('invalid')
  const validate = (target: string): string => {
    const clean = canonicalUrl(target)
    if (!clean) throw new ReadError('invalid')
    assertReadableUrl(clean)
    try {
      opts.validateUrl?.(clean)
    } catch {
      throw new ReadError('scope')
    }
    return clean
  }
  validate(url)
  const start = Date.now(),
    db = getDb()
  const cached = db
    .select()
    .from(webPages)
    .where(and(eq(webPages.url, url), gte(webPages.fetchedAt, start - 86400000), lte(webPages.fetchedAt, start)))
    .orderBy(desc(webPages.fetchedAt))
    .limit(1)
    .get()
  if (cached) {
    validate(cached.finalUrl)
    const page = opts.incognito ? remember(toView(cached)) : toView(cached)
    recordCall('reader', cached.method, true, true, start)
    return { page, passages: passages(page.text) }
  }
  const release = reserveCall()
  let kind: WebPageView['method'] = 'fetch',
    ok = false,
    finalUrl = url
  const fetchOptions = {
    signal: opts.signal,
    maxBytes: 5 * 1024 * 1024,
    validateUrl: (target: string): void => {
      finalUrl = validate(target)
    }
  }
  try {
    let response: Awaited<ReturnType<typeof externalFetch>>
    try {
      response = await externalFetch(url, fetchOptions)
    } catch (error) {
      if (error instanceof Error && error.message === 'Response too large') {
        if (!/\.pdf$/i.test(new URL(finalUrl).pathname)) {
          // 超限错误未保留响应头；仅此失败边界用HEAD确认PDF，不能普遍放宽网页正文上限。
          let validated = false
          try {
            const metadata = await externalFetch(finalUrl, {
              ...fetchOptions,
              method: 'HEAD',
              // helper先检查Content-Length，HEAD也须容纳允许读取的PDF大小。
              maxBytes: 20 * 1024 * 1024,
              validateUrl: (target) => {
                const clean = validate(target)
                // helper会将部分HEAD重定向降为GET；先检查策略，再拒绝再次跳转。
                if (validated) throw new ReadError('size')
                validated = true
                finalUrl = clean
              }
            })
            if (metadata.status !== 200 || !metadata.headers.get('content-type')?.toLowerCase().includes('application/pdf'))
              throw new ReadError('size')
          } catch (probeError) {
            if (probeError instanceof PagePolicyError || probeError instanceof ReadError) throw probeError
            throw new ReadError('size')
          }
        }
        kind = 'pdf'
        response = await externalFetch(finalUrl, { ...fetchOptions, maxBytes: 20 * 1024 * 1024 })
      } else throw error
    }
    if (opts.signal?.aborted) throw new ReadError('canceled')
    validate(finalUrl)
    const type = response.headers.get('content-type')?.toLowerCase() ?? ''
    const pdf = type.includes('application/pdf') || /\.pdf$/i.test(new URL(finalUrl).pathname)
    // HEAD与重试GET之间内容可能变化，20MB通路仍必须满足PDF合同，不能抽取超限HTML。
    if (kind === 'pdf' && !pdf) throw new ReadError('size')
    let readable: ReadablePage
    if (pdf) {
      kind = 'pdf'
      if (response.status !== 200) throw new Error('HTTP ' + response.status)
      readable = await parsePdf(response.bytes, finalUrl, opts.signal)
    } else {
      const isHtml = /(?:text\/html|application\/xhtml\+xml)/.test(type)
      if (response.status !== 200 && !([403, 429].includes(response.status) && isHtml)) throw new Error('HTTP ' + response.status)
      if (!isHtml) throw new ReadError('unsupported')
      readable = extractReadable(response.text, finalUrl)
      if (response.status !== 200 || readable.text.length < 500) {
        kind = 'render'
        checkBudget()
        validate(finalUrl)
        const rendered = await renderPage(finalUrl, {
          signal: opts.signal,
          validateUrl: (target) => {
            finalUrl = validate(target)
          }
        })
        finalUrl = validate(rendered.finalUrl)
        readable = extractReadable(rendered.html, finalUrl)
        if (readable.text.length < 200) throw new ReadError('empty')
      }
    }
    if (opts.signal?.aborted) throw new ReadError('canceled')
    validate(url)
    validate(finalUrl)
    const text = readable.text.slice(0, 60000)
    const snapshot: Snapshot = {
      url,
      finalUrl,
      title: readable.title,
      siteName: readable.siteName,
      publishedAt: readable.publishedAt,
      fetchedAt: Date.now(),
      method: kind,
      lang: readable.lang,
      text,
      textHash: createHash('sha256').update(text).digest('hex')
    }
    const page = opts.incognito ? remember(toView({ ...snapshot, id: '' })) : persist(snapshot)
    const result = { page, passages: passages(page.text) }
    ok = true
    return result
  } catch (error) {
    if (opts.signal?.aborted) throw new ReadError('canceled')
    if (error instanceof PagePolicyError || error instanceof ReadError) throw error
    if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) {
      const status = Number(error.message.slice(5))
      // 原始错误可能包含查询或凭证；对外错误仅保留已验证的HTTP状态码。
      // eslint-disable-next-line preserve-caught-error
      throw new Error(tr('网页打不开（HTTP ' + status + '）', 'Page could not be opened (HTTP ' + status + ')'))
    }
    throw new ReadError('failed')
  } finally {
    try {
      recordCall('reader', kind, ok, false, start)
    } finally {
      release()
    }
  }
}
