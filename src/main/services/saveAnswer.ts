import { conversationAttachmentIds, protectProposalAttachments } from './attachmentDerived'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { sources } from '../db/schema'
import { createNote, getNote } from './notes'
import { createProposal } from './proposals'
import { markdownToNodes } from '../lib/markdown'
import { getSettings } from './settings'
import { fmtTime } from '@shared/context'
import type { SaveAnswer } from '@shared/schemas'

// 「存入笔记」：就地提问的答案写成康奈尔笔记的一行——线索 = 问题，笔记 = 答案 + 出处链接。
// 这是用户主动的操作，以“自动应用”的提案写入：保留 AI 来源标记与撤销，又无需再逐条确认。

/** 资料出处链接：jiwei://source/<id>?seg=<片段>&page=<页>&t=<秒> */
export function sourceHref(sourceId: string, a?: SaveAnswer['anchor']): string {
  const q = new URLSearchParams()
  if (a?.ownerId) q.set('seg', a.ownerId)
  if (a?.page) q.set('page', String(a.page))
  if (a?.t) q.set('t', String(Math.floor(a.t[0])))
  const qs = q.toString()
  return `jiwei://source/${sourceId}${qs ? `?${qs}` : ''}`
}

export function saveAnswer(input: SaveAnswer): { noteId: string; created: boolean; proposalId: string } {
  const zh = getSettings().language.startsWith('zh')
  const src = input.sourceId
    ? getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, input.sourceId)).get()
    : undefined
  let noteId = input.noteId
  let created = false
  if (!noteId || !getNote(noteId)) {
    noteId = createNote({ title: src ? (zh ? `《${src.title}》学习笔记` : `Notes on ${src.title}`) : '' }).id
    created = true
  }
  const body = markdownToNodes(input.answer)
  if (src && input.sourceId) {
    const a = input.anchor
    const where = a?.t ? ` · ${fmtTime(a.t[0])}` : a?.page ? (zh ? ` · 第 ${a.page} 页` : ` · p.${a.page}`) : ''
    body.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: zh ? '出处：' : 'Source: ' },
        { type: 'text', text: `《${src.title}》${where}`, marks: [{ type: 'link', attrs: { href: sourceHref(input.sourceId, a) } }] }
      ]
    })
  }
  const proposal = createProposal({
    noteId,
    title: zh ? '存入笔记' : 'Save to note',
    ops: [{ op: 'insert_row', afterRowId: null, cue: input.cue.trim() ? markdownToNodes(input.cue) : [], body }],
    model: input.model,
    sources: input.anchor?.ownerId && input.anchor.parentType === 'source' ? [{ type: 'segment', id: input.anchor.ownerId }] : undefined,
    auto: true
  })
  protectProposalAttachments(proposal.id, [
    ...(input.conversationId ? conversationAttachmentIds(input.conversationId) : []),
    ...(input.sourceId ? [input.sourceId] : [])
  ])
  return { noteId, created, proposalId: proposal.id }
}
