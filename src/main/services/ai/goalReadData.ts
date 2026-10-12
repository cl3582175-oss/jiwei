import { z } from 'zod'
import { goalProgress, listGoals } from '../progress'
import { phases, milestones } from '../plan/phases'
import { ReadPage, readableReferenceIds } from './readData'

const Details = z
  .object({
    goalId: z.string().min(1).max(64),
    kind: z.enum(['phases', 'milestones', 'noteIds', 'sourceIds', 'goalNoteIds']),
    phaseId: z.string().min(1).max(64).optional(),
    offset: z.number().int().min(0).default(0)
  })
  .refine((v) => !['noteIds', 'sourceIds'].includes(v.kind) || !!v.phaseId, 'phaseId is required for phase references')
export const GoalListInput = z
  .object({ includeMetadata: z.boolean().optional(), ...ReadPage, details: Details.optional() })
  .refine((v) => !v.details || v.includeMetadata === true, 'details requires includeMetadata:true')
type Detail = z.infer<typeof Details>
const context = {
  missingHistory: ['past goal snapshots'],
  guidance:
    'Dates are schedules; completion requires stored status/doneAt. Progress is current, not weekly change. Follow each non-null next with goals_list; nested pages have independent coverage.'
}
const MAX_JSON = 18000
const request = (details: Detail) => ({ includeMetadata: true as const, details })
function coverage(total: number, returned: number, details: Detail) {
  return { total, returned, next: returned < total ? request({ ...details, offset: returned }) : null }
}
// 测量最终序列化文本，避免“条数有限”却因合法长字段被20k包装器从JSON中间截断。
function boundedPage<T>(
  rows: T[],
  offset: number,
  limit: number,
  next: (offset: number) => unknown,
  project: (row: T) => unknown = (row) => row
) {
  let count = Math.min(limit, Math.max(0, rows.length - offset))
  const projected = rows.slice(offset, offset + count).map(project)
  for (;;) {
    const hasMore = offset + count < rows.length
    const result = {
      items: projected.slice(0, count),
      total: rows.length,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + count : null,
      next: hasMore ? next(offset + count) : null,
      ...context
    }
    if (JSON.stringify(result).length <= MAX_JSON) return result
    if (count <= 1) throw new Error('Goal metadata record exceeds the supported output size')
    count--
  }
}
function phaseRows(goalId: string) {
  return phases(goalId)
    .sort((a, b) => a.position - b.position || a.startAt - b.startAt || a.id.localeCompare(b.id))
    .map((p) => {
      const noteIds = readableReferenceIds('note', p.noteIds),
        sourceIds = readableReferenceIds('source', p.sourceIds)
      return {
        ...p,
        noteIds: [] as string[],
        sourceIds: [] as string[],
        referencePages: {
          noteIds: coverage(noteIds.length, 0, { goalId, phaseId: p.id, kind: 'noteIds', offset: 0 }),
          sourceIds: coverage(sourceIds.length, 0, { goalId, phaseId: p.id, kind: 'sourceIds', offset: 0 })
        }
      }
    })
}
function milestoneRows(goalId: string) {
  return milestones(goalId).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
export function readGoalMetadata(input: z.infer<typeof GoalListInput>) {
  const goals = listGoals().filter((g) => g.status === 'active'),
    limit = input.limit ?? 50
  if (input.details) {
    const d = input.details,
      goal = goals.find((g) => g.id === d.goalId)
    if (!goal) throw new Error('Active goal not found')
    let rows: unknown[]
    if (d.kind === 'phases') rows = phaseRows(goal.id)
    else if (d.kind === 'milestones') rows = milestoneRows(goal.id)
    else if (d.kind === 'goalNoteIds') rows = readableReferenceIds('note', goal.noteIds)
    else {
      const phase = phases(goal.id).find((p) => p.id === d.phaseId)
      if (!phase) throw new Error('Phase not found in goal')
      rows = readableReferenceIds(d.kind === 'noteIds' ? 'note' : 'source', phase[d.kind])
    }
    // 引用权限每次重查，offset是在允许的数据中计数，而不是在原始私有数组中计数。
    return boundedPage(rows, d.offset, limit, (offset) => request({ ...d, offset }))
  }
  return boundedPage(
    goals,
    input.offset ?? 0,
    limit,
    (offset) => ({ includeMetadata: true, limit, offset }),
    (g) => {
      const ps = phaseRows(g.id),
        ms = milestoneRows(g.id),
        ids = readableReferenceIds('note', g.noteIds)
      const { goal: _goal, ...progress } = goalProgress(g.id)
      // goalProgress.goal 与外层重复，且包含未经分页的noteIds；只保留实际进度数值。
      const item = {
        ...g,
        noteIds: [] as string[],
        noteIdsPage: coverage(ids.length, 0, { goalId: g.id, kind: 'goalNoteIds', offset: 0 }),
        progress,
        phases: ps.slice(0, 1),
        milestones: ms.slice(0, 1),
        phasesPage: coverage(ps.length, Math.min(1, ps.length), { goalId: g.id, kind: 'phases', offset: 0 }),
        milestonesPage: coverage(ms.length, Math.min(1, ms.length), { goalId: g.id, kind: 'milestones', offset: 0 })
      }
      // 合法目标描述与首个阶段可能同时很长：概览退到纯目标，嵌套数据仍可从0继续。
      if (JSON.stringify(item).length > MAX_JSON - 1500) {
        item.phases = []
        item.milestones = []
        item.phasesPage = coverage(ps.length, 0, { goalId: g.id, kind: 'phases', offset: 0 })
        item.milestonesPage = coverage(ms.length, 0, { goalId: g.id, kind: 'milestones', offset: 0 })
      }
      return item
    }
  )
}
