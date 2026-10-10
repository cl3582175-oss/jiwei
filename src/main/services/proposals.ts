import { and, desc, eq, or } from 'drizzle-orm'
import { getDb } from '../db'
import { derivationLandings, notes, proposals } from '../db/schema'
import { newId } from '../lib/ids'
import { emit } from '../events'
import type { ProposalInput } from '@shared/schemas'
import type { Proposal, ProposalOpStatus } from '@shared/types'
import { recordProposalDecision } from './memoryLearn'
import { lensMessage } from './recordingContext'

// AI 修改提案：主进程只负责记录与状态流转；
// 真正把操作应用到文档由渲染进程的编辑器完成（保证走正常的撤销、协同、ID 与来源标记流程）。

type Row = typeof proposals.$inferSelect

function toProposal(r: Row): Proposal {
  const payload = JSON.parse(r.ops) as { ops: Proposal['ops']; embeds?: Proposal['embeds']; auto?: boolean; skill?: string }
  return {
    id: r.id,
    noteId: r.noteId,
    title: r.title,
    ops: payload.ops,
    embeds: payload.embeds ?? {},
    opStatus: JSON.parse(r.opStatus) as ProposalOpStatus[],
    status: r.status,
    model: r.model,
    sources: r.sources ? (JSON.parse(r.sources) as Proposal['sources']) : null,
    auto: !!payload.auto,
    skill: payload.skill ?? null,
    createdAt: r.createdAt
  }
}

export function createProposal(input: ProposalInput): Proposal {
  const db = getDb()
  const note = db
    .select({ id: notes.id, aiExcluded: notes.aiExcluded, deletedAt: notes.deletedAt })
    .from(notes)
    .where(eq(notes.id, input.noteId))
    .get()
  if (!note || note.deletedAt) throw new Error('Note not found')
  // 隐私：用户设为“不发送给 AI”的笔记，AI 也不能修改
  if (note.aiExcluded) throw new Error('This note is excluded from AI')
  const row: Row = {
    id: newId(),
    noteId: input.noteId,
    title: input.title,
    ops: JSON.stringify({
      ops: input.ops,
      embeds: input.embeds ?? {},
      ...(input.auto ? { auto: true } : {}),
      ...(input.skill ? { skill: input.skill } : {})
    }),
    opStatus: JSON.stringify(input.ops.map(() => 'pending')),
    status: 'pending',
    model: input.model ?? null,
    sources: input.sources ? JSON.stringify(input.sources) : null,
    createdAt: Date.now(),
    resolvedAt: null
  }
  db.insert(proposals).values(row).run()
  emit('proposals:changed', { noteId: input.noteId })
  return toProposal(row)
}

export function listProposals(noteId: string): Proposal[] {
  return getDb()
    .select()
    .from(proposals)
    .where(and(eq(proposals.noteId, noteId), eq(proposals.status, 'pending')))
    .orderBy(desc(proposals.createdAt))
    .all()
    .map(toProposal)
}

export function resolveUserOp(id: string, opIndex: number, decision: 'accepted' | 'rejected', blockIds?: string[]): Proposal {
  if (
    getDb()
      .select({ id: derivationLandings.id })
      .from(derivationLandings)
      .where(or(eq(derivationLandings.proposalId, id), eq(derivationLandings.undoProposalId, id)))
      .get()
  )
    throw new Error(lensMessage('reviewInSource'))
  return resolveOp(id, opIndex, decision, blockIds)
}
export function resolveOp(id: string, opIndex: number, decision: 'accepted' | 'rejected', blockIds?: string[]): Proposal {
  const db = getDb()
  const r = db.select().from(proposals).where(eq(proposals.id, id)).get()
  if (!r) throw new Error('Proposal not found')
  const status = JSON.parse(r.opStatus) as ProposalOpStatus[]
  if (opIndex >= status.length) throw new Error('Invalid op index')
  status[opIndex] = decision
  const done = status.every((s) => s !== 'pending')
  db.update(proposals)
    .set({ opStatus: JSON.stringify(status), status: done ? 'resolved' : 'pending', resolvedAt: done ? Date.now() : null })
    .where(eq(proposals.id, id))
    .run()
  emit('proposals:changed', { noteId: r.noteId })
  const p = toProposal(db.select().from(proposals).where(eq(proposals.id, id)).get()!)
  try {
    recordProposalDecision(p, opIndex, decision, blockIds)
  } catch {
    /* 学习偏好失败不影响提案 */
  }
  return p
}

export function deleteProposalsForNote(noteId: string): void {
  getDb().delete(proposals).where(eq(proposals.noteId, noteId)).run()
}
