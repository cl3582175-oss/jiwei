import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { z } from 'zod'
import { MilestoneSave, PhaseSave, type GoalMilestone, type GoalPhase } from '@shared/plan'
import { getDb } from '../../db'
import { actions, goalMilestones, goalPhases, goals, notes, planEvents, sources } from '../../db/schema'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { emit } from '../../events'

function direction(id: string): void {
  if (
    !getDb()
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), isNull(goals.deletedAt)))
      .get()
  )
    throw new Error('Direction not found')
}
function parentPhase(id: string, goalId: string): void {
  if (
    !getDb()
      .select()
      .from(goalPhases)
      .where(and(eq(goalPhases.id, id), eq(goalPhases.goalId, goalId), isNull(goalPhases.deletedAt)))
      .get()
  )
    throw new Error('Phase not found in direction')
}
export function phases(goalId: string): GoalPhase[] {
  direction(goalId)
  const db = getDb(),
    acts = db
      .select()
      .from(actions)
      .where(and(eq(actions.goalId, goalId), isNull(actions.deletedAt)))
      .all()
  const sessions = db
    .select()
    .from(planEvents)
    .where(and(eq(planEvents.goalId, goalId), eq(planEvents.kind, 'study'), isNull(planEvents.deletedAt)))
    .all()
  return db
    .select()
    .from(goalPhases)
    .where(and(eq(goalPhases.goalId, goalId), isNull(goalPhases.deletedAt)))
    .orderBy(asc(goalPhases.position), asc(goalPhases.startAt))
    .all()
    .map((r) => {
      const units = [
        ...acts.filter((a) => a.phaseId === r.id && a.status !== 'dropped'),
        ...sessions.filter((s) => s.phaseId === r.id && s.status !== 'skipped')
      ]
      return {
        ...r,
        noteIds: JSON.parse(r.noteIds),
        sourceIds: JSON.parse(r.sourceIds),
        progress: units.length ? units.filter((u) => u.status === 'done').length / units.length : r.status === 'done' ? 1 : 0
      }
    })
}
export function phaseSave(input: z.input<typeof PhaseSave>): GoalPhase {
  const v = PhaseSave.parse(input),
    db = getDb(),
    now = Date.now(),
    id = v.id ?? newId()
  direction(v.goalId)
  if (v.id) parentPhase(v.id, v.goalId)
  const ns = v.noteIds.length
    ? db
        .select({ id: notes.id })
        .from(notes)
        .where(and(inArray(notes.id, v.noteIds), isNull(notes.deletedAt)))
        .all()
    : []
  const ss = v.sourceIds.length
    ? db
        .select({ id: sources.id })
        .from(sources)
        .where(and(inArray(sources.id, v.sourceIds), isNull(sources.deletedAt)))
        .all()
    : []
  if (ns.length !== new Set(v.noteIds).size || ss.length !== new Set(v.sourceIds).size) throw new Error('Linked resource not found')
  const row = {
    ...v,
    origin: 'user' as const,
    noteIds: JSON.stringify([...new Set(v.noteIds)]),
    sourceIds: JSON.stringify([...new Set(v.sourceIds)]),
    updatedAt: now,
    updatedBy: deviceId()
  }
  if (v.id) db.update(goalPhases).set(row).where(eq(goalPhases.id, id)).run()
  else
    db.insert(goalPhases)
      .values({ ...row, id, createdAt: now })
      .run()
  emit('plan:changed', {})
  return phases(v.goalId).find((p) => p.id === id)!
}
export function phaseRemove(id: string): void {
  const db = getDb(),
    now = Date.now()
  db.transaction((tx) => {
    tx.update(goalPhases).set({ deletedAt: now, updatedAt: now, updatedBy: deviceId() }).where(eq(goalPhases.id, id)).run()
    tx.update(goalMilestones).set({ phaseId: null, updatedAt: now, updatedBy: deviceId() }).where(eq(goalMilestones.phaseId, id)).run()
    tx.update(actions).set({ phaseId: null, updatedAt: now, updatedBy: deviceId() }).where(eq(actions.phaseId, id)).run()
    tx.update(planEvents).set({ phaseId: null, updatedAt: now, updatedBy: deviceId() }).where(eq(planEvents.phaseId, id)).run()
  })
  emit('plan:changed', {})
  emit('reflection:changed', {})
}
export function milestones(goalId: string): GoalMilestone[] {
  return getDb()
    .select()
    .from(goalMilestones)
    .where(and(eq(goalMilestones.goalId, goalId), isNull(goalMilestones.deletedAt)))
    .orderBy(asc(goalMilestones.at))
    .all()
}
export function milestoneSave(input: z.input<typeof MilestoneSave>): GoalMilestone {
  const v = MilestoneSave.parse(input),
    db = getDb(),
    id = v.id ?? newId(),
    now = Date.now()
  direction(v.goalId)
  if (v.phaseId) parentPhase(v.phaseId, v.goalId)
  if (
    v.id &&
    !db
      .select()
      .from(goalMilestones)
      .where(and(eq(goalMilestones.id, id), eq(goalMilestones.goalId, v.goalId), isNull(goalMilestones.deletedAt)))
      .get()
  )
    throw new Error('Milestone not found')
  const row = { ...v, origin: 'user' as const, updatedAt: now, updatedBy: deviceId() }
  if (v.id) db.update(goalMilestones).set(row).where(eq(goalMilestones.id, id)).run()
  else
    db.insert(goalMilestones)
      .values({ ...row, id, createdAt: now })
      .run()
  emit('plan:changed', {})
  return { ...v, id }
}
export function milestoneRemove(id: string): void {
  getDb()
    .update(goalMilestones)
    .set({ deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(goalMilestones.id, id))
    .run()
  emit('plan:changed', {})
}
