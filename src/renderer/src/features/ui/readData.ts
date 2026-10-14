import type { UiNode } from '@shared/ui/catalog'
import type { ActionItem, BlockInfo, Citation, NoteMastery, NoteSummary, Segment } from '@shared/types'
import type { PlanEvent } from '@shared/plan'
import { api } from '@/lib/utils'
import type { UiContext } from './context'

export type DataNode = Extract<UiNode, { type: 'schedule' | 'tasks' | 'note' | 'excerpt' | 'mastery' }>
export interface NoteRow {
  id: string
  cue: string
  body: string
}
export type UiData =
  | { type: 'schedule'; events: PlanEvent[] }
  | { type: 'tasks'; actions: ActionItem[] }
  | { type: 'note'; note: NoteSummary; rows: NoteRow[] }
  | { type: 'excerpt'; text: string; title: string; citation?: Citation; segment?: Segment }
  | { type: 'mastery'; notes: NoteMastery[]; due: number }
async function noteMeta(id: string): Promise<NoteSummary> {
  const note = await api.notes.get(id)
  if (!note || note.deletedAt !== null || note.aiExcluded) throw new Error('note-unavailable')
  return note
}
function rowsOf(blocks: BlockInfo[], rowIds?: string[]): NoteRow[] {
  const rows = new Map<string, NoteRow>()
  for (const block of blocks) {
    if (!block.rowId || (rowIds && !rowIds.includes(block.rowId))) continue
    if (!rows.has(block.rowId)) rows.set(block.rowId, { id: block.rowId, cue: '', body: '' })
    const row = rows.get(block.rowId)!
    if (block.section === 'cue') row.cue += (row.cue ? '\n' : '') + block.text
    if (block.section === 'body') row.body += (row.body ? '\n' : '') + block.text
  }
  return [...rows.values()].slice(0, 5)
}
export async function readUiData(node: DataNode, ctx: UiContext): Promise<UiData> {
  switch (node.type) {
    case 'schedule':
      return {
        type: 'schedule',
        events: await api.plan.events({
          startAt: new Date(`${node.range.from}T00:00`).getTime(),
          endAt: new Date(`${node.range.to}T23:59:59.999`).getTime() + 1
        })
      }
    case 'tasks': {
      let actions = await api.actions.list('open')
      if (node.filter?.scope === 'today') {
        const end = new Date()
        end.setHours(24, 0, 0, 0)
        actions = actions.filter((a) => a.dueAt !== null && a.dueAt < end.getTime())
      }
      if (node.filter?.scope === 'goal') {
        if (!(await api.goals.list().then((goals) => goals.find((g) => g.id === node.filter!.goalId)))) throw new Error('goal-unavailable')
        actions = actions.filter((a) => a.goalId === node.filter!.goalId)
      }
      if (node.filter?.scope === 'note') {
        const id = node.filter.noteId!
        await noteMeta(id)
        const reviewIds = [...new Set(actions.flatMap((a) => (a.reviewId ? [a.reviewId] : [])))]
        const reviews = await Promise.all(reviewIds.map((id) => api.reflection.get(id)))
        const ids = new Set(reviews.filter((r) => r?.noteId === id).map((r) => r!.id))
        const goals = await api.goals.list()
        const phases = (await Promise.all(goals.map((g) => api.plan.phases(g.id)))).flat()
        const relatedPhases = new Set(phases.filter((p) => p.noteIds.includes(id)).map((p) => p.id))
        actions = actions.filter((a) => (!!a.reviewId && ids.has(a.reviewId)) || (!!a.phaseId && relatedPhases.has(a.phaseId)))
      }
      return { type: 'tasks', actions }
    }
    case 'note': {
      const note = await noteMeta(node.noteId)
      return { type: 'note', note, rows: rowsOf(await api.notes.blocks(node.noteId), node.rowIds) }
    }
    case 'excerpt': {
      const citation = ctx.message?.citations.find((c) => (node.cite !== undefined ? c.n === node.cite : c.ownerId === node.segmentId))
      if (citation?.parentType === 'note') {
        await noteMeta(citation.parentId)
        const blocks = await api.notes.blocks(citation.parentId)
        const block = blocks.find((b) => b.id === citation.ownerId)
        if (!block) throw new Error('excerpt-unavailable')
        return { type: 'excerpt', text: block.text, title: citation.title, citation }
      }
      if (citation?.parentType === 'web') {
        if (citation.snippetOnly) return { type: 'excerpt', text: citation.snippet, title: citation.title, citation }
        const page = await api.retrieval.page(citation.parentId)
        if (!page) throw new Error('excerpt-unavailable')
        const text = citation.snippet || page.text
        return { type: 'excerpt', text, title: citation.title, citation }
      }
      const segment = await api.segments.get(node.segmentId ?? citation?.ownerId ?? '')
      if (!segment) throw new Error('excerpt-unavailable')
      const source = await api.sources.get(segment.sourceId)
      if (!source || source.deletedAt !== null || source.aiExcluded) throw new Error('excerpt-unavailable')
      return {
        type: 'excerpt',
        text: segment.text,
        title: source.title,
        citation: citation ?? {
          n: 0,
          parentType: 'source',
          parentId: source.id,
          ownerId: segment.id,
          title: source.title,
          snippet: segment.text,
          locator: typeof segment.locator.value === 'string' ? segment.locator.value : null,
          learnedAt: null,
          updatedAt: 0,
          status: null,
          origin: 'user'
        },
        segment
      }
    }
    case 'mastery': {
      if (node.scope.kind === 'goal' && !(await api.goals.list().then((goals) => goals.find((g) => g.id === node.scope.id))))
        throw new Error('goal-unavailable')
      const data = await api.mastery.map(node.scope.kind === 'goal' ? node.scope.id! : null)
      const candidates = node.scope.kind === 'note' ? data.notes.filter((n) => n.id === node.scope.id) : data.notes
      const allowed = await Promise.all(
        candidates.map(async (n) => {
          const meta = await api.notes.get(n.id)
          return meta && meta.deletedAt === null && !meta.aiExcluded ? n : null
        })
      )
      const notes = allowed.filter((n): n is NoteMastery => n !== null),
        ids = new Set(notes.map((n) => n.id))
      const today = await api.review.today()
      return { type: 'mastery', notes, due: today.filter((c) => ids.has(c.noteId) && c.bucket !== 'new').length }
    }
  }
}
export function dataText(data: UiData): string {
  switch (data.type) {
    case 'schedule':
      return data.events
        .map((e) => `${e.title} (${new Date(e.startAt).toLocaleString()} – ${new Date(e.endAt).toLocaleString()})`)
        .join('\n')
    case 'tasks':
      return data.actions.map((a) => `- ${a.title}${a.dueAt ? ` (${new Date(a.dueAt).toLocaleDateString()})` : ''}`).join('\n')
    case 'note':
      return [data.note.title, ...data.rows.map((r) => `${r.cue}\n${r.body}`)].join('\n')
    case 'excerpt':
      return `${data.title}\n${data.text}`
    case 'mastery':
      return data.notes.map((n) => `${n.title}: ${n.status}${n.recall !== null ? ` (${Math.round(n.recall * 100)}%)` : ''}`).join('\n')
  }
}
