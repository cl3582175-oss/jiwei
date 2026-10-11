import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import type { EventInput, PlanEvent, ReviewForecast } from '@shared/plan'
import { EventSave, addDays, dayStart } from '@shared/plan'
import { getDb } from '../../db'
import { actions, cards, goals, notes, planEvents } from '../../db/schema'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { emit } from '../../events'
import { getSettings } from '../settings'
import { forecastCards } from './forecast'

export function forecast(days = 42): ReviewForecast[] {
  const rows = getDb()
    .select({ due: cards.due, state: cards.state, suspended: cards.suspended })
    .from(cards)
    .innerJoin(notes, eq(notes.id, cards.noteId))
    .where(and(isNull(cards.deletedAt), isNull(notes.deletedAt), eq(notes.reviewExcluded, false)))
    .all()
  return forecastCards(rows, days, getSettings().review.newPerDay)
}

export function events(range: { startAt: number; endAt: number }, virtual = true): PlanEvent[] {
  const db = getDb()
  const gs = db.select().from(goals).where(isNull(goals.deletedAt)).all()
  const result: PlanEvent[] = db
    .select()
    .from(planEvents)
    .where(and(isNull(planEvents.deletedAt), lt(planEvents.startAt, range.endAt), gt(planEvents.endAt, range.startAt)))
    .all()
    .map((e) => ({ ...e, readonly: e.origin === 'ics', color: gs.find((g) => g.id === e.goalId)?.color }))
  if (virtual) {
    const marker = (
      id: string,
      title: string,
      at: number,
      kind: 'deadline' | 'exam',
      goalId: string | null,
      link: PlanEvent['link']
    ): PlanEvent => ({
      id,
      title,
      startAt: dayStart(at),
      endAt: addDays(dayStart(at), 1),
      allDay: true,
      kind,
      goalId,
      phaseId: null,
      status: 'planned',
      origin: 'user',
      feedId: null,
      uid: null,
      note: null,
      readonly: true,
      link,
      color: gs.find((g) => g.id === goalId)?.color
    })
    for (const a of db
      .select()
      .from(actions)
      .where(and(isNull(actions.deletedAt), eq(actions.status, 'open')))
      .all())
      if (a.dueAt !== null && a.dueAt >= range.startAt && a.dueAt < range.endAt)
        result.push(marker(`action:${a.id}`, a.title, a.dueAt, 'deadline', a.goalId, { type: 'action', id: a.id }))
    for (const g of gs)
      if (g.status === 'active' && g.targetAt !== null && g.targetAt >= range.startAt && g.targetAt < range.endAt)
        result.push(marker(`goal:${g.id}`, g.title, g.targetAt, g.kind === 'exam' ? 'exam' : 'deadline', g.id, { type: 'goal', id: g.id }))
  }
  return result.sort((a, b) => a.startAt - b.startAt)
}

export function eventSave(input: EventInput): PlanEvent {
  const v = EventSave.parse(input),
    db = getDb(),
    now = Date.now()
  const old = v.id
    ? db
        .select()
        .from(planEvents)
        .where(and(eq(planEvents.id, v.id), isNull(planEvents.deletedAt)))
        .get()
    : undefined
  if (v.id && !old) throw new Error('Event not found')
  if (old?.origin === 'ics') throw new Error('Subscribed events are read-only')
  if (
    v.goalId &&
    !db
      .select()
      .from(goals)
      .where(and(eq(goals.id, v.goalId), isNull(goals.deletedAt)))
      .get()
  )
    throw new Error('Direction not found')
  let startAt = v.startAt,
    endAt = v.endAt
  if (v.allDay) {
    startAt = dayStart(startAt)
    endAt = Math.max(addDays(startAt, 1), dayStart(endAt))
  }
  const id = v.id ?? newId()
  // 手动改期后改变 origin，之后 AI 再排期必须保留；单独标记状态不视为改期。
  const edited =
    old &&
    (old.startAt !== startAt ||
      old.endAt !== endAt ||
      old.title !== v.title ||
      old.goalId !== (v.goalId === undefined ? old.goalId : v.goalId) ||
      old.note !== (v.note === undefined ? old.note : v.note) ||
      old.kind !== v.kind ||
      old.allDay !== v.allDay)
  const row = {
    title: v.title,
    kind: v.kind,
    startAt,
    endAt,
    allDay: v.allDay,
    goalId: v.goalId === undefined ? (old?.goalId ?? null) : v.goalId,
    phaseId: v.phaseId === undefined ? (old?.phaseId ?? null) : v.phaseId,
    status: v.status ?? old?.status ?? 'planned',
    note: v.note === undefined ? (old?.note ?? null) : v.note,
    origin: edited ? ('user' as const) : (old?.origin ?? ('user' as const)),
    updatedAt: now,
    updatedBy: deviceId()
  }
  if (old) db.update(planEvents).set(row).where(eq(planEvents.id, id)).run()
  else
    db.insert(planEvents)
      .values({ ...row, id, createdAt: now })
      .run()
  emit('plan:changed', {})
  return { ...db.select().from(planEvents).where(eq(planEvents.id, id)).get()! }
}

export function eventRemove(id: string): void {
  const db = getDb(),
    old = db.select().from(planEvents).where(eq(planEvents.id, id)).get()
  if (!old || old.origin === 'ics') throw new Error('Event is missing or read-only')
  db.update(planEvents).set({ deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(planEvents.id, id)).run()
  emit('plan:changed', {})
}
