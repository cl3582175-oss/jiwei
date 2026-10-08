import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { notes, sources } from '../../db/schema'
import { listSegments } from '../segments'
import { loadDoc, stateToContent } from '../docs'
import { nodeText } from '../../lib/derive'
import { fmtTime, type Anchor, type ContextPacket } from '@shared/context'
import type { DocNode, Segment } from '@shared/types'

// 上下文包 → 提示词：把用户“指着”的内容连同必要的前后文交给模型。
// 隐私：标记为“不让 AI 读取”或已删除的笔记 / 资料一律跳过。

const NEIGHBORS = 2
const MAX_SURROUND = 1800

export interface ResolvedContext {
  /** 给模型的上下文文本 */
  text: string
  /** 用于检索的补充查询（选中的文字等） */
  query: string
  /** 涉及的笔记 / 资料（供工具默认使用） */
  noteId: string | null
  sourceId: string | null
}

type SourceRow = { title: string; kind: string; aiExcluded: boolean; deletedAt: number | null }
type NoteRow = { title: string; aiExcluded: boolean; deletedAt: number | null }

function sourceRow(id: string): SourceRow | null {
  const r = getDb()
    .select({ title: sources.title, kind: sources.kind, aiExcluded: sources.aiExcluded, deletedAt: sources.deletedAt })
    .from(sources)
    .where(eq(sources.id, id))
    .get()
  return r && !r.aiExcluded && !r.deletedAt ? r : null
}

function noteRow(id: string): NoteRow | null {
  const r = getDb()
    .select({ title: notes.title, aiExcluded: notes.aiExcluded, deletedAt: notes.deletedAt })
    .from(notes)
    .where(eq(notes.id, id))
    .get()
  return r && !r.aiExcluded && !r.deletedAt ? r : null
}

const segTime = (s: Segment): [number, number] | null => {
  const v = String((s.locator as { value?: unknown }).value ?? '')
  const m = v.match(/t=([\d.]+)(?:,([\d.]+))?/)
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null
}
const segLabel = (s: Segment): string => {
  const v = String((s.locator as { value?: unknown }).value ?? '')
  const t = segTime(s)
  if (t) return `${fmtTime(t[0])}–${fmtTime(t[1])}`
  return v
    .replace('page=', '第 ')
    .replace(/^第 (\d+)$/, '第 $1 页')
    .replace('chapter=', '章节 ')
}
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** 资料中的锚点：片段 + 前后片段（媒体按时间段取转写稿） */
function sourceAnchor(anchor: Anchor, zh: boolean): string | null {
  // 媒体播放中、没有标出时间段：取当前时刻之前 30 秒的转写稿（“他刚才说的”）
  const a: Anchor = anchor.kind === 'viewport' && anchor.t ? { ...anchor, t: [Math.max(0, anchor.t[0] - 30), anchor.t[0] + 5] } : anchor
  const src = sourceRow(a.parentId)
  if (!src) return null
  const segs = listSegments(a.parentId)
  const head = `${zh ? '资料' : 'Source'}《${src.title}》`
  const kindLabel: Record<Anchor['kind'], [string, string]> = {
    'source-text': ['用户在资料中选中的文字', 'Text the user selected in the source'],
    'note-text': ['用户在笔记中选中的文字', 'Text selected in the note'],
    block: ['用户指向的段落', 'Block the user points at'],
    'media-range': ['用户标出的时间段', 'Time range the user marked'],
    region: ['用户框选的区域', 'Region the user selected'],
    viewport: ['用户当前看到的部分（没有选中具体内容）', 'What the user currently sees (nothing selected)']
  }
  const lines = [
    `${kindLabel[a.kind][zh ? 0 : 1]} · ${head}${a.page ? ` · ${zh ? `第 ${a.page} 页` : `p.${a.page}`}` : ''}${a.t ? ` · ${fmtTime(a.t[0])}–${fmtTime(a.t[1])}` : ''}`
  ]

  if (a.t && segs.some((s) => segTime(s))) {
    // 视频 / 音频：取与时间段重叠的转写稿
    const [t0, t1] = a.t
    const hit = segs.filter((s) => {
      const st = segTime(s)
      return st && st[1] >= t0 && st[0] <= t1
    })
    if (hit.length)
      lines.push(`${zh ? '转写稿' : 'Transcript'}：\n${clip(hit.map((s) => `[${segLabel(s)}] ${s.text}`).join('\n'), MAX_SURROUND * 2)}`)
  }
  if (a.quote) lines.push(`「${a.quote}」`)
  const idx = a.ownerId
    ? segs.findIndex((s) => s.id === a.ownerId)
    : a.page
      ? segs.findIndex((s) => segLabel(s).includes(`第 ${a.page} 页`))
      : -1
  if (idx >= 0 && !a.t) {
    const around = segs.slice(Math.max(0, idx - NEIGHBORS), idx + NEIGHBORS + 1)
    lines.push(
      `${zh ? '所在位置的原文（含前后文；片段 ID 可用于 source_read 和导图挂原文）' : 'Surrounding text (segment IDs usable with source_read)'}：\n${clip(
        around.map((s) => `[${s.id}${segLabel(s) ? ' · ' + segLabel(s) : ''}] ${s.text}`).join('\n'),
        MAX_SURROUND
      )}`
    )
  }
  return lines.join('\n')
}

/** 在文档中找到块及其所在行 */
function findInDoc(doc: { content?: DocNode[] }, id: string): { node: DocNode; row: DocNode | null } | null {
  let found: { node: DocNode; row: DocNode | null } | null = null
  const walk = (n: DocNode, row: DocNode | null): void => {
    if (found) return
    if (n.attrs?.id === id) found = { node: n, row }
    for (const c of n.content ?? []) walk(c, n.type === 'cornellRow' ? n : row)
  }
  for (const c of doc.content ?? []) walk(c, null)
  return found
}

function rowText(row: DocNode, zh: boolean): string {
  const cue = row.content?.find((c) => c.type === 'cornellCue')
  const body = row.content?.find((c) => c.type === 'cornellBody')
  return `${zh ? '线索' : 'Cue'}：${cue ? nodeText(cue).trim() || '（空）' : ''}\n${zh ? '笔记' : 'Notes'}：${body ? nodeText(body).trim() : ''}`
}

function noteAnchor(a: Anchor, zh: boolean): string | null {
  const n = noteRow(a.parentId)
  if (!n) return null
  const lines = [
    `${a.kind === 'block' ? (zh ? '用户指向的段落' : 'Block') : zh ? '用户在笔记中选中的文字' : 'Text selected in the note'} · ${zh ? '笔记' : 'Note'}《${n.title || (zh ? '无标题' : 'Untitled')}》`
  ]
  if (a.quote) lines.push(`「${a.quote}」`)
  if (a.ownerId) {
    const { doc } = stateToContent(loadDoc(a.parentId))
    const f = findInDoc(doc, a.ownerId)
    if (f) {
      lines.push(`${zh ? '所在段落 ID（修改时用于 note_replace_block）' : 'Block ID (for note_replace_block)'}：${a.ownerId}`)
      if (f.row) lines.push(`${zh ? '所在行' : 'Row'}（${f.row.attrs?.id}）：\n${clip(rowText(f.row, zh), MAX_SURROUND)}`)
    }
  }
  return lines.join('\n')
}

export function resolveContext(p: ContextPacket | undefined, zh: boolean): ResolvedContext {
  const empty: ResolvedContext = { text: '', query: '', noteId: null, sourceId: null }
  if (!p) return empty
  const parts: string[] = []
  const queries: string[] = []
  const noteId = p.noteId && noteRow(p.noteId) ? p.noteId : null
  const sourceId = p.sourceId && sourceRow(p.sourceId) ? p.sourceId : null

  for (const a of p.targets) {
    const t = a.parentType === 'source' ? sourceAnchor(a, zh) : noteAnchor(a, zh)
    if (t) {
      parts.push(t)
      if (a.quote) queries.push(a.quote)
    }
  }
  if (!p.targets.length && p.viewport) {
    const t = p.viewport.parentType === 'source' ? sourceAnchor(p.viewport, zh) : null
    if (t) parts.push(t)
  }
  // 工作区背景：正在编辑的笔记（光标所在行）、正在看的资料
  const bg: string[] = []
  if (noteId) {
    const n = noteRow(noteId)!
    let line = `${zh ? '正在编辑的笔记' : 'Note being edited'}《${n.title || (zh ? '无标题' : 'Untitled')}》（ID：${noteId}）`
    if (p.cursorRowId && !p.targets.some((a) => a.parentType === 'note'))
      line += `，${zh ? '光标所在行' : 'cursor row'} ID：${p.cursorRowId}`
    bg.push(line)
  }
  if (sourceId && !parts.length)
    bg.push(`${zh ? '正在阅读的资料' : 'Source being read'}《${sourceRow(sourceId)!.title}》（ID：${sourceId}）`)
  else if (sourceId) bg.push(`${zh ? '资料 ID' : 'Source ID'}：${sourceId}`)

  const text = [...parts, ...(bg.length ? [bg.join('\n')] : [])].join('\n\n')
  return { text, query: queries.join('\n').slice(0, 2000), noteId, sourceId }
}
