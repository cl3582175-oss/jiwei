import { conversationAttachmentIds, protectProposalAttachments } from './attachmentDerived'
import { and, eq, isNull } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb } from '../db'
import { conversations, messages, uiStates } from '../db/schema'
import { UiSaveToNoteSchema, type UiSaveToNote, type ProposalOp } from '@shared/schemas'
import { toChartData } from '@shared/ui/catalog'
import { createNote, getNote } from './notes'
import { createProposal } from './proposals'
import { visual } from './ai/embedProposal'
import { markdownToNodes } from '../lib/markdown'
import { getSettings } from './settings'
import type { Citation, Origin } from '@shared/types'

function answer(messageId: string) {
  const row = getDb()
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      model: messages.model,
      citations: messages.citations,
      title: conversations.title,
      incognito: conversations.incognito
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(messages.id, messageId), eq(messages.role, 'assistant'), isNull(conversations.deletedAt)))
    .get()
  if (!row) throw new Error(getSettings().language.startsWith('zh') ? '这条回答已不可用' : 'This response is unavailable')
  return row
}
export function states(messageId: string): Record<string, unknown> {
  if (answer(messageId).incognito) return {}
  return Object.fromEntries(
    getDb()
      .select()
      .from(uiStates)
      .where(eq(uiStates.messageId, messageId))
      .all()
      .flatMap((row) => {
        try {
          return [[row.componentId, JSON.parse(row.state)]]
        } catch {
          return []
        }
      })
  )
}
export function saveState(messageId: string, componentId: string, state: unknown): void {
  if (answer(messageId).incognito) return
  let json: string | undefined
  try {
    json = JSON.stringify(state)
  } catch {
    /* 非 JSON 状态不落库 */
  }
  if (!json || new TextEncoder().encode(json).length > 16_384) {
    log.warn('[ui] state exceeds limit or is not JSON')
    return
  }
  getDb()
    .insert(uiStates)
    .values({ messageId, componentId, state: json, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: [uiStates.messageId, uiStates.componentId], set: { state: json, updatedAt: Date.now() } })
    .run()
}
export function saveToNote(input: UiSaveToNote): { noteId: string; created: boolean; proposalId: string } {
  const value = UiSaveToNoteSchema.parse(input),
    source = answer(value.messageId)
  if (source.conversationId !== value.conversationId) throw new Error('Response does not belong to this conversation')
  const node = value.node,
    zh = getSettings().language.startsWith('zh')
  const citations = source.citations ? (JSON.parse(source.citations) as Citation[]) : []
  const refs: NonNullable<Origin['sources']> = []
  for (const c of citations) {
    if (c.parentType === 'note') refs.push({ type: 'block', id: c.ownerId })
    else if (c.parentType === 'source') refs.push({ type: 'segment', id: c.ownerId })
  }
  return getDb().transaction(() => {
    const existing = value.target.noteId ? getNote(value.target.noteId) : null
    if (value.target.noteId && (!existing || existing.aiExcluded))
      throw new Error(zh ? '这篇笔记已不可用或设置了不给 AI' : 'Note is unavailable or excluded from AI')
    const target = existing ?? createNote({ title: value.target.newTitle ?? node.title ?? source.title }),
      created = !existing
    const title = (zh ? '存进笔记：' : 'Save to note: ') + (node.title ?? target.title).slice(0, 180)
    const options = { auto: true, model: source.model ?? undefined, sources: refs }
    let proposal
    switch (node.type) {
      case 'chart':
        proposal = visual(target.id, title, 'chart', toChartData(node), undefined, undefined, options)
        break
      case 'diagram':
        proposal = visual(
          target.id,
          title,
          'diagram',
          { code: node.code, title: node.diagramTitle ?? node.title },
          undefined,
          undefined,
          options
        )
        break
      case 'timeline':
        proposal = visual(target.id, title, 'timeline', { title: node.title, events: node.events }, undefined, undefined, options)
        break
      case 'codesteps':
        proposal = visual(
          target.id,
          title,
          'steps',
          { title: node.title, language: node.language, code: node.code, steps: node.steps },
          undefined,
          undefined,
          options
        )
        break
      default: {
        let rows: { cue: string; body: string }[] | undefined
        if (node.type === 'flashcards') rows = node.cards.map((c) => ({ cue: c.front, body: c.back }))
        if (node.type === 'cloze')
          rows = [
            {
              cue: node.text.replace(/\{\{[^{}]+\}\}/g, '____'),
              body: [node.text.replace(/\{\{([^{}]+)\}\}/g, '$1'), node.explain].filter(Boolean).join('\n\n')
            }
          ]
        if (node.type === 'quiz' && value.mode === 'rows')
          rows = node.items.map((q) => ({
            cue: [q.q, ...(q.options ?? []).map((o, i) => `${i + 1}. ${o}`)].join('\n'),
            body: [(zh ? '答案：' : 'Answer: ') + (q.options ? q.options[q.answer as number] : q.answer), q.explain].join('\n\n')
          }))
        if (rows) {
          const ops: ProposalOp[] = rows.map((row) => ({
            op: 'insert_row',
            afterRowId: null,
            cue: markdownToNodes(row.cue),
            body: markdownToNodes(row.body)
          }))
          proposal = createProposal({ noteId: target.id, title, ops, ...options })
        } else
          proposal = visual(
            target.id,
            title,
            'ui',
            {
              node,
              state: { ...(value.state && typeof value.state === 'object' && !Array.isArray(value.state) ? value.state : {}), citations },
              savedAt: Date.now(),
              from: { conversationId: source.conversationId, messageId: source.id }
            },
            undefined,
            undefined,
            options
          )
      }
    }
    protectProposalAttachments(proposal.id, conversationAttachmentIds(source.conversationId))
    return { noteId: target.id, created, proposalId: proposal.id }
  })
}
