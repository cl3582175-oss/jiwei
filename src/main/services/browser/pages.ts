import { extname } from 'path'
import { and, eq, isNull } from 'drizzle-orm'
import log from 'electron-log/main'
import { z } from 'zod'
import { getDb } from '../../db'
import { conversations, messages, sources } from '../../db/schema'
import { emit } from '../../events'
import { canonicalUrl } from '../../lib/browserPolicy'
import { importPaths, saveWebPage } from '../sources'
import { listAnnotations } from '../annotations'
import { similarTo } from '../ai/retrieve'
import { structured, quickModel } from '../ai/structured'
import { createProposal } from '../proposals'
import { createNote, getNote } from '../notes'
import { markdownToNodes } from '../../lib/markdown'
import { sourceHref } from '../saveAnswer'
import { getSettings } from '../settings'
import * as m from './manager'

// 内置浏览器的页面能力（v0.6.0）：存为资料、相关笔记旁注、读取网页（AI 只读工具）、下载导入、离开时的回顾。

const zh = (): boolean => getSettings().language.startsWith('zh')

/* ——— 存为资料 ——— */

/** 把标签页中的网页存为资料（已存过则复用）；敏感页面与无痕标签不存 */
const saving = new Map<string, Promise<string>>()
export async function saveTab(tabId?: string | null): Promise<string> {
  const t = m.getTab(tabId)
  if (!t) throw new Error('没有打开的网页')
  const key = `${t.id}:${t.scope}`
  const pending = saving.get(key)
  if (pending) return pending
  const work = saveCurrentTab(t.id)
  saving.set(key, work)
  try {
    return await work
  } finally {
    if (saving.get(key) === work) saving.delete(key)
  }
}

async function saveCurrentTab(tabId: string): Promise<string> {
  const t = m.getTab(tabId)
  if (!t) throw new Error('没有打开的网页')
  if (m.isSensitive(t.id)) throw new Error(zh() ? '这个网页设为不发送给 AI，不能存为资料' : 'AI is off on this page')
  if (t.incognito) throw new Error(zh() ? '无痕标签中的网页不会存为资料' : 'Incognito pages are not saved')
  const url = t.view.webContents.getURL()
  if (!/^https?:/i.test(url)) throw new Error(zh() ? '这个页面不能存为资料' : 'This page cannot be saved')
  const scope = t.scope
  const valid = (): boolean =>
    m.getTab(t.id) === t && t.scope === scope && !t.incognito && !m.isSensitive(t.id) && t.view.webContents.getURL() === url
  if (t.sourceId) {
    const existing = getDb().select().from(sources).where(eq(sources.id, t.sourceId)).get()
    if (existing && !existing.deletedAt && !existing.aiExcluded && existing.url === canonicalUrl(url)) return existing.id
  }
  const html = await m.inPage<string>(t.id, 'document.documentElement.outerHTML')
  if (!valid()) throw new Error('Page changed')
  const src = await saveWebPage({ url: canonicalUrl(url), title: t.view.webContents.getTitle(), html }, valid)
  if (!valid()) throw new Error('Page changed')
  m.markInteraction(t.id, src.id)
  pushAnnotations(t.id)
  return src.id
}

/** 已存为资料的网页：把它的批注发给内容脚本绘制高亮 */
export function pushAnnotations(tabId: string): void {
  const t = m.getTab(tabId)
  if (!t || t.incognito || m.isSensitive(tabId)) return
  let sourceId = t.sourceId
  if (!sourceId) {
    const url = canonicalUrl(t.view.webContents.getURL())
    sourceId =
      getDb()
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.url, url), eq(sources.kind, 'web'), isNull(sources.deletedAt)))
        .get()?.id ?? null
    if (sourceId) t.sourceId = sourceId
  }
  const list = sourceId ? listAnnotations('source', sourceId) : []
  m.toPage(tabId, 'jw-page:annotations', {
    items: list.map((a) => ({
      id: a.id,
      quote: a.selector.quote ?? '',
      prefix: a.selector.prefix ?? '',
      suffix: a.selector.suffix ?? '',
      color: a.color ?? 'yellow',
      question: a.motivation === 'questioning',
      note: !!a.body?.trim()
    }))
  })
}

/** 批注变化时，更新正在显示这份资料的标签页 */
export function onAnnotationsChanged(targetType: string, targetId: string): void {
  if (targetType !== 'source') return
  for (const tab of m.browserState().tabs) if (tab.sourceId === targetId) pushAnnotations(tab.id)
}

/* ——— 读取网页（AI 只读工具） ——— */

const READ_PAGE = `(() => {
  const root = document.querySelector('article, main, [role=main]') || document.body
  const text = (root ? root.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
  return { url: location.href, title: document.title, text, selection: String(getSelection() || '').trim() }
})()`

export interface PageText {
  url: string
  title: string
  text: string
  selection: string
}

export async function readPage(tabId?: string | null, max = 20000): Promise<PageText> {
  const t = m.getTab(tabId)
  if (!t) throw new Error('没有打开的网页')
  if (m.isSensitive(t.id) || t.incognito) throw new Error(zh() ? '这个网页设为不发送给 AI（敏感页面或无痕标签）' : 'AI is off on this page')
  const r = await m.inPage<PageText>(t.id, READ_PAGE)
  return { ...r, text: r.text.slice(0, max) }
}

/** 在网页中查找关键词，返回带上下文的片段 */
export async function findInPage(query: string, tabId?: string | null): Promise<{ count: number; matches: string[] }> {
  const { text } = await readPage(tabId, 200000)
  const q = query.trim()
  if (!q) return { count: 0, matches: [] }
  const out: string[] = []
  let count = 0
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
    count++
    if (out.length < 10) out.push(text.slice(Math.max(0, i - 80), i + q.length + 80).replace(/\s+/g, ' '))
  }
  return { count, matches: out }
}

export async function pageLinks(tabId?: string | null): Promise<{ text: string; href: string }[]> {
  const t = m.getTab(tabId)
  if (!t || t.incognito || m.isSensitive(t.id)) return []
  return m.inPage<{ text: string; href: string }[]>(
    t.id,
    `[...document.querySelectorAll('a[href]')].map(a => ({ text: (a.innerText || a.title || '').trim().slice(0, 120), href: a.href })).filter(l => /^https?:/.test(l.href) && l.text).slice(0, 200)`
  )
}

/* ——— 相关笔记旁注（本地向量，不花钱） ——— */

const MIN_SIM = 0.55
const relatedTimers = new Map<string, NodeJS.Timeout>()

export function scheduleRelated(tabId: string): void {
  clearTimeout(relatedTimers.get(tabId))
  relatedTimers.set(
    tabId,
    setTimeout(() => {
      relatedTimers.delete(tabId)
      void related(tabId).catch((e) => log.warn('[browser] related', e))
    }, 1500)
  )
}

async function related(tabId: string): Promise<void> {
  const t = m.getTab(tabId)
  if (!t || t.incognito || m.isSensitive(tabId)) return
  if ((getSettings().browser?.proactivity ?? 'balanced') === 'quiet') return
  const url = t.view.webContents.getURL()
  if (!/^https?:/i.test(url)) return
  const page = await readPage(tabId, 1500)
  const hits = await similarTo(`${page.title}\n${page.text}`, { type: 'all' }, 8, MIN_SIM)
  const self = canonicalUrl(url)
  const seen = new Set<string>()
  const items: BrowserRelatedItem[] = []
  for (const h of hits) {
    const key = `${h.parentType}:${h.parentId}`
    if (seen.has(key)) continue
    seen.add(key)
    // 本网页自己的资料不算
    if (
      h.parentType === 'source' &&
      getDb().select({ url: sources.url }).from(sources).where(eq(sources.id, h.parentId)).get()?.url === self
    )
      continue
    items.push({ type: h.parentType, id: h.parentId, title: h.title, text: h.text.slice(0, 140) })
    if (items.length >= 3) break
  }
  if (m.getTab(tabId)?.view.webContents.getURL() !== url) return
  emit('browser:related', { tabId, url, items })
}
type BrowserRelatedItem = { type: 'note' | 'source'; id: string; title: string; text: string }

/* ——— 下载：可导入的文件自动进入资料库 ——— */

const IMPORTABLE = new Set([
  'pdf',
  'epub',
  'docx',
  'md',
  'txt',
  'html',
  'htm',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'mp3',
  'm4a',
  'wav',
  'mp4',
  'mov',
  'webm',
  'srt',
  'vtt'
])

export async function onDownloaded(path: string, name: string): Promise<void> {
  const ext = extname(name).slice(1).toLowerCase()
  if (!IMPORTABLE.has(ext)) {
    emit('browser:download', { name, sourceId: null, path })
    return
  }
  try {
    const r = await importPaths([path])
    const src = r.imported[0]
    emit('browser:download', { name, sourceId: src?.id ?? null, path })
  } catch (e) {
    log.warn('[browser] import download', e)
    emit('browser:download', { name, sourceId: null, path })
  }
}

/* ——— 离开时的回顾：把高亮与问答整理成笔记 ——— */

/** 关闭标签页时是否提示整理：停留超过 5 分钟、有过提问或批注、主动程度不是“安静” */
export function shouldRecap(tabId: string): { sourceId: string; title: string; highlights: number; questions: number } | null {
  if ((getSettings().browser?.proactivity ?? 'balanced') === 'quiet') return null
  const info = m.recapInfo(tabId)
  const minutes = getSettings().browser?.proactivity === 'active' ? 2 : 5
  if (!info?.sourceId || info.minutes < minutes || info.interactions < 1) return null
  const src = getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, info.sourceId)).get()
  if (!src) return null
  const highlights = listAnnotations('source', info.sourceId).length
  const questions = threadsOf(info.sourceId).length
  if (!highlights && !questions) return null
  return { sourceId: info.sourceId, title: src.title, highlights, questions }
}

/** 挂在这份资料上的就地提问（问题与回答） */
function threadsOf(sourceId: string): { q: string; a: string }[] {
  const db = getDb()
  const convs = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.kind, 'inline'), eq(conversations.anchorParentId, sourceId), isNull(conversations.deletedAt)))
    .all()
  const out: { q: string; a: string }[] = []
  for (const c of convs.slice(-20)) {
    const ms = db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, c.id))
      .orderBy(messages.createdAt)
      .all()
    const q = ms.find((x) => x.role === 'user')?.content ?? ''
    const a = ms.find((x) => x.role === 'assistant')?.content ?? ''
    if (q && a) out.push({ q: q.slice(0, 500), a: a.slice(0, 1200) })
  }
  return out
}

const RecapSchema = z.object({
  rows: z
    .array(
      z.object({
        cue: z.string().max(120).describe('线索：一个能检验自己是否理解的问题'),
        body: z.string().max(600).describe('笔记：用户自己的理解，简洁，可以用列表'),
        quote: z.string().max(200).optional().describe('依据：网页原文中的一句（来自高亮或问答）')
      })
    )
    .min(1)
    .max(5)
})

/** 把一份网页资料上的高亮、批注与问答整理成 1–5 行康奈尔笔记（提案，需确认） */
export async function recapToNote(sourceId: string, noteId: string | null): Promise<{ noteId: string; proposalId: string }> {
  const s = getSettings()
  if (!s.ai.chat.providerId || !s.ai.chat.model) throw new Error(zh() ? '还没有设置 AI 模型' : 'No AI model configured')
  const src = getDb().select({ title: sources.title, url: sources.url }).from(sources).where(eq(sources.id, sourceId)).get()
  if (!src) throw new Error('Source not found')
  const anns = listAnnotations('source', sourceId)
  const qa = threadsOf(sourceId)
  const material = [
    anns.length
      ? `高亮与批注：\n${anns.map((a) => `- ${a.motivation === 'questioning' ? '［存疑］' : ''}“${a.selector.quote ?? ''}”${a.body ? ` —— ${a.body}` : ''}`).join('\n')}`
      : '',
    qa.length ? `就地问答：\n${qa.map((x) => `问：${x.q}\n答：${x.a}`).join('\n\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  const out = await structured({
    providerId: s.ai.chat.providerId,
    model: quickModel(s.ai.chat.providerId, s.ai.chat.model),
    system: zh()
      ? '你帮学习者把读网页时留下的高亮、批注和问答，整理成康奈尔笔记的几行。每行：线索是一个能检验理解的问题；笔记写要点，保留用户批注里的原意和措辞，不要补充材料中没有的知识；不要写“用户批注”“来自高亮”之类的标注，直接写内容。宁少勿滥，1–5 行。'
      : 'Turn the learner’s highlights, comments and Q&A from a web page into 1–5 Cornell rows. Cue: a question that tests understanding. Note: the key points, keeping the learner’s own wording. Do not add knowledge not in the material, and do not label text as “user comment” or “highlight”; just write the content.',
    prompt: `网页：《${src.title}》\n\n${material}`,
    schema: RecapSchema
  })
  let target = noteId && getNote(noteId) ? noteId : null
  if (!target) target = createNote({ title: zh() ? `《${src.title}》阅读笔记` : `Reading notes: ${src.title}` }).id
  const link = (text: string) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href: sourceHref(sourceId) } }] })
  const p = createProposal({
    noteId: target,
    title: zh() ? `整理《${src.title}》的阅读` : `Reading notes from ${src.title}`,
    sources: [{ type: 'source', id: sourceId }],
    ops: out.rows.map((r) => ({
      op: 'insert_row' as const,
      afterRowId: null,
      cue: markdownToNodes(r.cue),
      body: [
        ...markdownToNodes(r.body),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: zh() ? '出处：' : 'Source: ' },
            link(`《${src.title}》${r.quote ? `“${r.quote.slice(0, 40)}”` : ''}`)
          ]
        }
      ]
    }))
  })
  return { noteId: target, proposalId: p.id }
}
