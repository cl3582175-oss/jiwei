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
import { readDeepSeekPage } from './readers/deepseek'

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
  provider?: 'deepseek'
  signal?: AbortSignal
  incognito?: boolean
  validateUrl?: (url: string) => void
}
type PageRow = typeof webPages.$inferSelect
type Snapshot = Omit<PageRow, 'id'>
// 最终地址仅供AI策略重查；不暴露到公共快照视图，也不让无痕快照落库。
const temporary = new Map<string, { page: WebPageView; finalUrl: string | null }>()
const messages = {
  invalid: ['网址无效', 'Invalid address'],
  canceled: ['读取已取消', 'Reading canceled'],
  scope: ['这个网址不在允许读取的范围内', 'This address is outside the allowed reading scope'],
  failed: ['网页读取失败，请稍后再试', 'Page reading failed. Try again later'],
  unsupported: ['暂不支持读取这种类型的内容', 'This content type cannot be read yet'],
  empty: ['这个网页没有可读的正文（可能需要登录）', 'This page has no readable text (it may require a login)'],
  scanned: ['这是扫描版 PDF，暂时读不出文字', 'This is a scanned PDF; its text cannot be read yet'],
  size: ['网页或文件过大，暂时无法读取', 'This page or file is too large to read'],
  expired: ['网页快照已失效', 'The page snapshot is no longer available'],
  restricted: ['该页面存在访问限制，不能使用云端绕过', 'The page has access restrictions; cloud reading cannot bypass them']
} as const
class ReadError extends Error {
  constructor(
    readonly reason: keyof typeof messages,
    status?: number
  ) {
    const m = messages[reason]
    super(status === undefined ? tr(m[0], m[1]) : tr('网页打不开（HTTP ' + status + '）', 'Page could not be opened (HTTP ' + status + ')'))
    this.name = 'ReadError'
  }
}
export const canSupplementRead = (error: unknown): boolean =>
  (error instanceof ReadError && ['failed', 'empty'].includes(error.reason)) ||
  (error instanceof Error && error.name === 'RenderError' && 'reason' in error && ['failed', 'timeout'].includes(String(error.reason)))
const toView = (row: PageRow | (Snapshot & { id: string })): WebPageView => ({
  id: row.id,
  url: row.url,
  title: row.title,
  siteName: row.siteName,
  publishedAt: row.publishedAt,
  fetchedAt: row.fetchedAt,
  method: row.method,
  ...(row.provider === 'deepseek'
    ? { webOrigin: { provider: 'deepseek' as const, urlVerified: false as const, truncated: row.truncated } }
    : {}),
  text: row.text
})
function remember(page: WebPageView, finalUrl: string | null): WebPageView {
  const copy = { ...page, id: 'tmp-' + newId() }
  temporary.set(copy.id, { page: { ...copy }, finalUrl })
  while (temporary.size > 50) {
    const oldest = temporary.keys().next().value
    if (oldest !== undefined) temporary.delete(oldest)
  }
  return copy
}
export function getPage(id: string): WebPageView | null {
  if (id.startsWith('tmp-')) {
    const snapshot = temporary.get(id)
    return snapshot ? { ...snapshot.page } : null
  }
  const row = getDb().select().from(webPages).where(eq(webPages.id, id)).get()
  return row ? toView(row) : null
}
/** 恢复旧引用/发送给模型前按当前策略检查两端地址；用户查看快照的合同不变。 */
export function assertPageReadable(id: string, allowCloud = false): void {
  const memory = id.startsWith('tmp-') ? temporary.get(id) : undefined
  const snapshot = id.startsWith('tmp-')
    ? memory && { url: memory.page.url, finalUrl: memory.finalUrl, cloud: !!memory.page.webOrigin }
    : (() => {
        const row = getDb().select().from(webPages).where(eq(webPages.id, id)).get()
        return row && { ...row, cloud: row.provider === 'deepseek' }
      })()
  if (!snapshot) return
  assertReadableUrl(snapshot.url)
  if (snapshot.cloud && !allowCloud) throw new ReadError('scope')
  if (snapshot.finalUrl) assertReadableUrl(snapshot.finalUrl)
  else if (!snapshot.cloud) throw new ReadError('invalid')
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
  const source = await saveWebPage({ url: page.url, title: page.title, html, webOrigin: page.webOrigin })
  return { sourceId: source.id }
}
const PASSAGE_TARGET = 400,
  PASSAGE_MAX = 1200
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
  // 再把相邻短段合并到 400 字左右（不超过 1200 字）：PDF 常常一行一段，段太碎时挑出的几段装不下完整的意思。
  const merged: typeof pieces = []
  for (const piece of pieces) {
    const last = merged.at(-1)
    if (last && last.text.length < PASSAGE_TARGET && piece.end - last.start <= PASSAGE_MAX)
      merged[merged.length - 1] = { start: last.start, end: piece.end, text: text.slice(last.start, piece.end) }
    else merged.push(piece)
  }
  return merged.map((piece, index) => ({ ...piece, index, suspicious: isSuspicious(piece.text) }))
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
    const condition = and(
      eq(webPages.url, snapshot.url),
      eq(webPages.textHash, snapshot.textHash),
      eq(webPages.provider, snapshot.provider),
      eq(webPages.truncated, snapshot.truncated)
    )
    const existing = db.select().from(webPages).where(condition).get()
    if (existing) {
      if (existing.finalUrl) assertReadableUrl(existing.finalUrl)
      db.update(webPages).set({ fetchedAt: snapshot.fetchedAt }).where(eq(webPages.id, existing.id)).run()
      return toView({ ...existing, fetchedAt: snapshot.fetchedAt })
    }
    const row: PageRow = { ...snapshot, id: newId() }
    db.insert(webPages).values(row).run()
    return toView(row)
  })
}
function pdfTitle(lines: string[]): string {
  let title = ''
  for (const line of lines.slice(0, 4)) {
    const clean = line.replace(/\s+/g, ' ').trim()
    if (!clean) continue
    title = title ? title + ' ' + clean : clean
    if (title.length >= 30) break
  }
  return title.slice(0, 120)
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
      // 论文标题常被排版拆成几行：取开头几段拼到 30 字以上，最长 120 字。
      title: pdfTitle(result.segments.map((segment) => segment.text)) || new URL(url).pathname.split('/').at(-1) || new URL(url).hostname,
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
  const canonical = canonicalUrl(value)
  if (!canonical) throw new ReadError('invalid')
  // Cloud consent is for the exact input. Validate credentials before any normalization can strip them.
  const url = opts.provider === 'deepseek' ? value : canonical
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
  if (opts.provider === 'deepseek') {
    const result = await readDeepSeekPage(url, {
      signal: opts.signal,
      guard: () => {
        checkBudget()
        validate(url)
      }
    })
    validate(url)
    const snapshot: Snapshot = {
      url,
      finalUrl: null,
      title: result.title,
      siteName: null,
      publishedAt: null,
      fetchedAt: Date.now(),
      method: 'fetch',
      provider: 'deepseek',
      truncated: result.truncated,
      lang: null,
      text: result.text,
      textHash: createHash('sha256').update(result.text).digest('hex')
    }
    const page = opts.incognito ? remember(toView({ ...snapshot, id: '' }), null) : persist(snapshot)
    return { page, passages: passages(page.text) }
  }
  const cached = db
    .select()
    .from(webPages)
    .where(
      and(eq(webPages.url, url), eq(webPages.provider, 'local'), gte(webPages.fetchedAt, start - 86400000), lte(webPages.fetchedAt, start))
    )
    .orderBy(desc(webPages.fetchedAt))
    .limit(1)
    .get()
  if (cached) {
    if (!cached.finalUrl) throw new ReadError('invalid')
    validate(cached.finalUrl)
    const page = opts.incognito ? remember(toView(cached), cached.finalUrl) : toView(cached)
    recordCall('reader', cached.method, true, true, start)
    return { page, passages: passages(page.text) }
  }
  const release = reserveCall()
  let kind: WebPageView['method'] = 'fetch',
    ok = false,
    finalUrl = url
  let cloudEligible = true
  const fetchOptions = {
    signal: opts.signal,
    maxBytes: 5 * 1024 * 1024,
    validateUrl: (target: string): void => {
      finalUrl = validate(target)
    }
  }
  try {
    const renderReadable = async (): Promise<ReadablePage> => {
      if (opts.signal?.aborted) throw new ReadError('canceled')
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
      const result = extractReadable(rendered.html, finalUrl)
      if (/(?:sign in to continue|log in to continue|subscribe to continue|请先登录|登录后|付费后)/i.test(result.text))
        cloudEligible = false
      if (result.text.length < 200) throw new ReadError('empty')
      return result
    }
    let response: Awaited<ReturnType<typeof externalFetch>> | null = null
    let readable: ReadablePage | null = null
    try {
      response = await externalFetch(url, fetchOptions)
    } catch (error) {
      if (error instanceof Error && error.message === 'Redirect was cancelled') {
        // Electron取消manual跳转时不暴露Location；只走已有受守卫的渲染，不放开自动跟随。
        readable = await renderReadable()
      } else if (error instanceof Error && error.message === 'Response too large') {
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
    if (response) {
      const type = response.headers.get('content-type')?.toLowerCase() ?? ''
      const pdf = type.includes('application/pdf') || /\.pdf$/i.test(new URL(finalUrl).pathname)
      // HEAD与重试GET之间内容可能变化，20MB通路仍必须满足PDF合同，不能抽取超限HTML。
      if (kind === 'pdf' && !pdf) throw new ReadError('size')
      if (pdf) {
        kind = 'pdf'
        if (response.status !== 200) throw new Error('HTTP ' + response.status)
        readable = await parsePdf(response.bytes, finalUrl, opts.signal)
      } else {
        if (response.status !== 200) cloudEligible = false
        const isHtml = /(?:text\/html|application\/xhtml\+xml)/.test(type)
        if (response.status !== 200 && !([403, 429].includes(response.status) && isHtml)) throw new Error('HTTP ' + response.status)
        if (!isHtml) throw new ReadError('unsupported')
        readable = extractReadable(response.text, finalUrl)
        if (response.status !== 200 || readable.text.length < 500) readable = await renderReadable()
      }
    }
    if (!readable) throw new ReadError('failed')
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
      provider: 'local',
      truncated: readable.text.length > 60000,
      lang: readable.lang,
      text,
      textHash: createHash('sha256').update(text).digest('hex')
    }
    const page = opts.incognito ? remember(toView({ ...snapshot, id: '' }), snapshot.finalUrl) : persist(snapshot)
    const result = { page, passages: passages(page.text) }
    ok = true
    return result
  } catch (error) {
    if (opts.signal?.aborted) throw new ReadError('canceled')
    if (error instanceof PagePolicyError) throw error
    if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) {
      const status = Number(error.message.slice(5))
      if (status >= 500) throw new ReadError('failed', status)
      // 原始错误可能包含查询或凭证；对外错误仅保留已验证的HTTP状态码。
      // eslint-disable-next-line preserve-caught-error
      throw new Error(tr('网页打不开（HTTP ' + status + '）', 'Page could not be opened (HTTP ' + status + ')'))
    }
    if (!cloudEligible) throw new ReadError('restricted')
    if (error instanceof ReadError || (error instanceof Error && error.name === 'RenderError')) throw error
    throw new ReadError('failed')
  } finally {
    try {
      recordCall('reader', kind, ok, false, start)
    } finally {
      release()
    }
  }
}
