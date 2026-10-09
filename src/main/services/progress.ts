import { and, eq, inArray, isNull, gte, sql } from 'drizzle-orm'
import { fsrs, generatorParameters, type Card as FsrsCard, State } from 'ts-fsrs'
import { getDb } from '../db'
import { actions, cards, categories, goals, links, notes, reviewLogs } from '../db/schema'
import { profileDb } from '../db/profile'
import { newId } from '../lib/ids'
import { masteryLevel, normConcept } from '../lib/learner'
import { cardSolid, noteStatus } from '../lib/mastery'
import { emit } from '../events'
import type { Goal, GoalProgress, MasteryMap, MasteryStatus, NoteMastery } from '@shared/types'
import type { GoalInput } from '@shared/schemas'
import { deviceId } from './device'
import { descendantIds } from './categories'
import { getSettings } from './settings'

// 学习目标与掌握度地图（v0.4.3）。
// 掌握度来自复习卡片的 FSRS 状态：可提取性（现在还记得的概率）+ 稳定性（记忆能保持多久）。
// 一篇笔记：没有线索 → 空白；有卡片没复习 → 未开始；否则按平均可提取性与稳定性分为薄弱 / 学习中 / 牢固。
// 学习目标关联分类与笔记，进度按其中的笔记与卡片汇总。设计见 docs/design/v0.4-learning-loop.md §5。

const DAY = 86_400_000

type CardRow = typeof cards.$inferSelect

function scheduler() {
  return fsrs(generatorParameters({ request_retention: getSettings().review.retention }))
}

const toFsrs = (c: CardRow): FsrsCard => ({
  due: new Date(c.due),
  stability: c.stability,
  difficulty: c.difficulty,
  elapsed_days: c.elapsedDays,
  scheduled_days: c.scheduledDays,
  learning_steps: c.learningSteps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state as State,
  last_review: c.lastReview ? new Date(c.lastReview) : undefined
})

/* ————————————————— 掌握度地图 ————————————————— */

function noteIdsForGoal(goalId: string): string[] | null {
  const g = getDb().select().from(goals).where(eq(goals.id, goalId)).get()
  if (!g) return null
  const ids = new Set(
    getDb()
      .select({ id: links.toId })
      .from(links)
      .where(and(eq(links.fromType, 'goal'), eq(links.fromId, goalId), eq(links.toType, 'note'), isNull(links.deletedAt)))
      .all()
      .map((l) => l.id)
  )
  if (g.categoryId) {
    const cats = descendantIds(g.categoryId)
    for (const n of getDb()
      .select({ id: notes.id })
      .from(notes)
      .where(and(inArray(notes.categoryId, cats), isNull(notes.deletedAt)))
      .all())
      ids.add(n.id)
  }
  return [...ids]
}

export function masteryMap(goalId?: string | null): MasteryMap {
  const db = getDb()
  const scope = goalId ? noteIdsForGoal(goalId) : null
  const noteRows = db
    .select({ id: notes.id, title: notes.title, categoryId: notes.categoryId, plainText: notes.plainText, wordCount: notes.wordCount, reviewExcluded: notes.reviewExcluded })
    .from(notes)
    .where(and(isNull(notes.deletedAt), eq(notes.kind, 'cornell'), scope ? inArray(notes.id, scope.length ? scope : ['-']) : undefined))
    .all()
    .filter((n) => n.wordCount > 0 && !n.reviewExcluded)
  const ids = noteRows.map((n) => n.id)
  const cardRows = ids.length
    ? db
        .select()
        .from(cards)
        .where(and(inArray(cards.noteId, ids), isNull(cards.deletedAt), eq(cards.suspended, false)))
        .all()
    : []
  const f = scheduler()
  const now = new Date()
  const byNote = new Map<string, CardRow[]>()
  for (const c of cardRows) byNote.set(c.noteId, [...(byNote.get(c.noteId) ?? []), c])

  // 薄弱的概念（学习者模型）出现在哪些笔记里
  const weak = (profileDb().prepare('SELECT name, norm, mastery FROM concepts').all() as { name: string; norm: string; mastery: number }[]).filter(
    (c) => masteryLevel(c.mastery) === 'weak' && c.norm.length >= 2
  )

  const list: NoteMastery[] = noteRows.map((n) => {
    const cs = byNote.get(n.id) ?? []
    const reviewed = cs.filter((c) => c.state !== State.New)
    const recall = reviewed.length ? reviewed.reduce((s, c) => s + f.get_retrievability(toFsrs(c), now, false), 0) / reviewed.length : null
    const stability = reviewed.length ? reviewed.reduce((s, c) => s + c.stability, 0) / reviewed.length : null
    const text = normConcept(`${n.title} ${n.plainText}`)
    const m = {
      id: n.id,
      title: n.title,
      categoryId: n.categoryId,
      cards: cs.length,
      reviewed: reviewed.length,
      recall: recall === null ? null : Math.round(recall * 1000) / 1000,
      stability: stability === null ? null : Math.round(stability * 10) / 10,
      lapses: cs.reduce((s, c) => s + c.lapses, 0),
      weakConcepts: weak.filter((c) => text.includes(c.norm)).map((c) => c.name).slice(0, 5)
    }
    return { ...m, status: noteStatus(m) }
  })
  const totals: Record<MasteryStatus, number> = { blank: 0, new: 0, weak: 0, learning: 0, solid: 0 }
  for (const n of list) totals[n.status]++
  const catIds = new Set(list.map((n) => n.categoryId).filter(Boolean) as string[])
  // 带上祖先分类，地图才能按层级展开
  const allCats = db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
    .from(categories)
    .where(and(eq(categories.kind, 'note'), isNull(categories.deletedAt)))
    .all()
  const byId = new Map(allCats.map((c) => [c.id, c]))
  for (const id of [...catIds]) {
    let p = byId.get(id)?.parentId
    while (p && !catIds.has(p)) {
      catIds.add(p)
      p = byId.get(p)?.parentId
    }
  }
  return { categories: allCats.filter((c) => catIds.has(c.id)), notes: list, totals }
}

/* ————————————————— 学习目标 ————————————————— */

type GoalRow = typeof goals.$inferSelect

function toGoal(g: GoalRow): Goal {
  const noteIds = getDb()
    .select({ id: links.toId })
    .from(links)
    .where(and(eq(links.fromType, 'goal'), eq(links.fromId, g.id), eq(links.toType, 'note'), isNull(links.deletedAt)))
    .all()
    .map((l) => l.id)
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    status: g.status,
    targetAt: g.targetAt,
    categoryId: g.categoryId,
    noteIds,
    createdAt: g.createdAt
  }
}

export function listGoals(): Goal[] {
  return getDb()
    .select()
    .from(goals)
    .where(isNull(goals.deletedAt))
    .orderBy(sql`CASE ${goals.status} WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END`, sql`${goals.targetAt} IS NULL`, goals.targetAt)
    .all()
    .map(toGoal)
}

export function saveGoal(input: GoalInput): Goal {
  const db = getDb()
  const now = Date.now()
  const id = input.id ?? newId()
  db.transaction((tx) => {
    if (input.id) {
      tx.update(goals)
        .set({
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.targetAt !== undefined ? { targetAt: input.targetAt } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          updatedAt: now,
          updatedBy: deviceId()
        })
        .where(eq(goals.id, id))
        .run()
    } else {
      tx.insert(goals)
        .values({
          id,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? 'active',
          targetAt: input.targetAt ?? null,
          categoryId: input.categoryId ?? null,
          createdAt: now,
          updatedAt: now,
          updatedBy: deviceId()
        })
        .run()
    }
    if (input.noteIds) {
      tx.delete(links)
        .where(and(eq(links.fromType, 'goal'), eq(links.fromId, id), eq(links.toType, 'note')))
        .run()
      for (const noteId of new Set(input.noteIds))
        tx.insert(links)
          .values({ id: newId(), fromType: 'goal', fromId: id, toType: 'note', toId: noteId, origin: 'manual', createdAt: now, updatedAt: now, updatedBy: deviceId() })
          .run()
    }
  })
  emit('reflection:changed', {})
  return toGoal(db.select().from(goals).where(eq(goals.id, id)).get()!)
}

/** 把一篇笔记关联到目标 / 取消关联 */
export function linkNoteToGoal(goalId: string, noteId: string, linked: boolean): Goal {
  const g = getDb().select().from(goals).where(eq(goals.id, goalId)).get()
  if (!g) throw new Error('Goal not found')
  const cur = toGoal(g)
  const noteIds = linked ? [...new Set([...cur.noteIds, noteId])] : cur.noteIds.filter((x) => x !== noteId)
  return saveGoal({ id: goalId, title: cur.title, noteIds })
}

export function removeGoal(id: string): void {
  const now = Date.now()
  getDb().update(goals).set({ deletedAt: now, updatedAt: now }).where(eq(goals.id, id)).run()
  emit('reflection:changed', {})
}

export function goalProgress(id: string): GoalProgress {
  const db = getDb()
  const g = db.select().from(goals).where(eq(goals.id, id)).get()
  if (!g) throw new Error('Goal not found')
  const map = masteryMap(id)
  const ids = map.notes.map((n) => n.id)
  const cardRows = ids.length ? db.select().from(cards).where(and(inArray(cards.noteId, ids), isNull(cards.deletedAt), eq(cards.suspended, false))).all() : []
  const f = scheduler()
  const now = new Date()
  const mastered = cardRows.filter((c) => c.state !== State.New && cardSolid(f.get_retrievability(toFsrs(c), now, false), c.stability)).length
  const reviewed = map.notes.reduce((s, n) => s + n.reviewed, 0)
  const recalls = map.notes.filter((n) => n.recall !== null)
  const reviews7d = cardRows.length
    ? (db
        .select({ n: sql<number>`count(*)` })
        .from(reviewLogs)
        .where(and(inArray(reviewLogs.cardId, cardRows.map((c) => c.id)), gte(reviewLogs.reviewedAt, Date.now() - 7 * DAY)))
        .get()?.n ?? 0)
    : 0
  return {
    goal: toGoal(g),
    notes: map.notes.length,
    cards: cardRows.length,
    reviewed,
    mastered: cardRows.length ? mastered / cardRows.length : 0,
    recall: recalls.length ? recalls.reduce((s, n) => s + n.recall!, 0) / recalls.length : null,
    reviews7d,
    weakNotes: map.totals.weak,
    blankNotes: map.totals.blank,
    openActions:
      db
        .select({ n: sql<number>`count(*)` })
        .from(actions)
        .where(and(eq(actions.goalId, id), eq(actions.status, 'open'), isNull(actions.deletedAt)))
        .get()?.n ?? 0,
    daysLeft: g.targetAt ? Math.ceil((g.targetAt - Date.now()) / DAY) : null
  }
}

/** 进行中的学习目标（放进 AI 的系统提示：回答时知道你在为什么而学） */
export function activeGoalsText(zh: boolean): string | null {
  const list = listGoals().filter((g) => g.status === 'active')
  if (!list.length) return null
  const fmt = (t: number): string => new Date(t).toISOString().slice(0, 10)
  return list
    .slice(0, 5)
    .map((g) => `- ${g.title}${g.targetAt ? `（${zh ? '目标日期' : 'by'} ${fmt(g.targetAt)}）` : ''}${g.description ? `：${g.description.slice(0, 120)}` : ''}`)
    .join('\n')
}
