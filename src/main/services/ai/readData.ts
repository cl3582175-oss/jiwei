import { fsrs, generatorParameters, State } from 'ts-fsrs'
import { cardSolid } from '../../lib/mastery'
import { requireMistakeCloud } from '../mistakesPrivacy'
import { getSettings } from '../settings'
import { z } from 'zod'
import { MistakeSubjectSchema } from '@shared/mistakes'
import { and, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db'
import { actions, cards, links, mistakes, notes, reviews, sources } from '../../db/schema'
import type { ChatScope } from '@shared/schemas'

// 半开区间让相邻日/周无重复；时间戳由调用方按用户时区构造，不解析标题日期。
export const ReadDateRange = z
  .object({ startAt: z.number().int().nonnegative(), endAt: z.number().int().nonnegative() })
  .refine((v) => v.endAt > v.startAt, 'endAt must be greater than startAt (exclusive)')
export const ReadPage = { limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).max(100000).optional() }
export const NoteFindInput = z
  .object({
    query: z.string().trim().max(200).optional(),
    dateRange: ReadDateRange.optional(),
    dateField: z.enum(['createdAt', 'editedAt']).default('editedAt'),
    includeMetadata: z.boolean().optional(),
    includeExcerpt: z.boolean().optional(),
    ...ReadPage
  })
  .refine((v) => !!v.query || !!v.dateRange, 'Provide query or dateRange')
export const ActionListInput = z.object({
  status: z.enum(['open', 'done', 'dropped', 'all']).default('open'),
  dateRange: ReadDateRange.optional(),
  dateField: z.enum(['createdAt', 'doneAt', 'dueAt']).default('createdAt'),
  goalId: z.string().max(64).optional(),
  includeMetadata: z.boolean().optional(),
  ...ReadPage
})
const escaped = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
export function page<T>(items: T[], limit: number, offset: number) {
  return { items: items.slice(0, limit), hasMore: items.length > limit, nextOffset: items.length > limit ? offset + limit : null }
}
export function noteReferences(id: string, scope: ChatScope) {
  if (scope.type === 'none' || (scope.type === 'items' && !scope.sources.length)) return []
  return getDb()
    .select({ sourceId: sources.id, title: sources.title, url: sources.url, selector: links.toSelector })
    .from(links)
    .innerJoin(sources, eq(sources.id, links.toId))
    .where(
      and(
        eq(links.fromType, 'note'),
        eq(links.fromId, id),
        eq(links.toType, 'source'),
        isNull(links.deletedAt),
        isNull(sources.deletedAt),
        eq(sources.aiExcluded, false),
        scope.type === 'items' ? inArray(sources.id, scope.sources) : undefined
      )
    )
    .limit(20)
    .all()
}
export function noteMetadata(id: string, scope: ChatScope) {
  const row = getDb()
    .select({ createdAt: notes.createdAt, editedAt: notes.editedAt, updatedAt: notes.updatedAt, learnedAt: notes.learnedAt })
    .from(notes)
    .where(eq(notes.id, id))
    .get()
  return { ...row, url: `jiwei://note/${id}`, sourceReferences: noteReferences(id, scope) }
}
export function findNotes(input: z.infer<typeof NoteFindInput>, scope: ChatScope) {
  const { query, dateRange, dateField, offset = 0 } = input
  const limit = Math.min(input.limit ?? 10, input.includeExcerpt ? 4 : 50)
  const conds: SQL[] = [isNull(notes.deletedAt), eq(notes.aiExcluded, false)]
  if (scope.type === 'none' || (scope.type === 'items' && !scope.notes.length)) return page([], limit, offset)
  if (scope.type === 'items') conds.push(inArray(notes.id, scope.notes))
  if (dateRange) conds.push(gte(notes[dateField], dateRange.startAt), lt(notes[dateField], dateRange.endAt))
  if (query) conds.push(sql`(${notes.title} LIKE ${escaped(query)} ESCAPE '\\' OR ${notes.plainText} LIKE ${escaped(query)} ESCAPE '\\')`)
  const rows = getDb()
    .select()
    .from(notes)
    .where(and(...conds))
    .orderBy(desc(notes[dateField]), notes.id)
    .limit(limit + 1)
    .offset(offset)
    .all()
  return page(
    rows.map((n) => ({
      id: n.id,
      title: n.title,
      ...(input.includeMetadata ? noteMetadata(n.id, scope) : {}),
      ...(input.includeExcerpt
        ? { excerpt: n.plainText.slice(0, 3000), excerptTruncated: n.plainText.length > 3000, totalCharacters: n.plainText.length }
        : {})
    })),
    limit,
    offset
  )
}
export function importedSources(range: z.infer<typeof ReadDateRange>, scope: ChatScope, query?: string, limit = 20, offset = 0) {
  const conds: SQL[] = [
    isNull(sources.deletedAt),
    eq(sources.aiExcluded, false),
    gte(sources.createdAt, range.startAt),
    lt(sources.createdAt, range.endAt)
  ]
  if (scope.type === 'none' || (scope.type === 'items' && !scope.sources.length)) return page([], limit, offset)
  if (scope.type === 'items') conds.push(inArray(sources.id, scope.sources))
  if (query?.trim())
    conds.push(
      sql`(${sources.title} LIKE ${escaped(query.trim())} ESCAPE '\\' OR EXISTS (SELECT 1 FROM source_segments g WHERE g.source_id = ${sources.id} AND g.text LIKE ${escaped(query.trim())} ESCAPE '\\'))`
    )
  return page(
    getDb()
      .select({
        sourceId: sources.id,
        title: sources.title,
        kind: sources.kind,
        url: sources.url,
        author: sources.author,
        createdAt: sources.createdAt,
        accessedAt: sources.accessedAt,
        publishedAt: sources.publishedAt
      })
      .from(sources)
      .where(and(...conds))
      .orderBy(desc(sources.createdAt), sources.id)
      .limit(limit + 1)
      .offset(offset)
      .all(),
    limit,
    offset
  )
}
export function readActions(input: z.infer<typeof ActionListInput>) {
  const { status, dateRange, dateField, goalId, limit = 50, offset = 0 } = input
  const conds: SQL[] = [isNull(actions.deletedAt)]
  if (status !== 'all') conds.push(eq(actions.status, status))
  if (goalId) conds.push(eq(actions.goalId, goalId))
  if (dateRange) conds.push(gte(actions[dateField], dateRange.startAt), lt(actions[dateField], dateRange.endAt))
  // 来源录音一旦被排除或删除，行动项原话也不能借 metadata 泄露给模型。
  conds.push(
    sql`(${actions.origin} IS NULL OR EXISTS (SELECT 1 FROM sources s WHERE s.id = json_extract(${actions.origin}, '$.sourceId') AND s.ai_excluded = 0 AND s.deleted_at IS NULL))`
  )
  conds.push(
    sql`(${actions.reviewId} IS NULL OR EXISTS (SELECT 1 FROM reviews r JOIN notes n ON n.id = r.note_id WHERE r.id = ${actions.reviewId} AND r.deleted_at IS NULL AND n.deleted_at IS NULL AND n.ai_excluded = 0))`
  )
  conds.push(
    sql`NOT EXISTS (SELECT 1 FROM links l LEFT JOIN notes n ON n.id = l.to_id WHERE l.from_type = 'action' AND l.from_id = ${actions.id} AND l.to_type = 'note' AND l.deleted_at IS NULL AND (n.id IS NULL OR n.deleted_at IS NOT NULL OR n.ai_excluded = 1))`
  )
  const rows = getDb()
    .select()
    .from(actions)
    .where(and(...conds))
    .orderBy(sql`${actions.dueAt} IS NULL`, actions.dueAt, desc(actions.createdAt), actions.id)
    .limit(limit + 1)
    .offset(offset)
    .all()
  return page(
    rows.map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      dueAt: a.dueAt,
      doneAt: a.doneAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      goalId: a.goalId,
      phaseId: a.phaseId,
      reviewId: a.reviewId,
      ownerName: a.ownerName,
      ownerPersonId: a.ownerPersonId,
      origin: a.origin ? JSON.parse(a.origin) : null,
      noteLinks: [
        ...new Set(
          [
            ...getDb()
              .select({ noteId: notes.id })
              .from(links)
              .innerJoin(notes, eq(notes.id, links.toId))
              .where(
                and(
                  eq(links.fromType, 'action'),
                  eq(links.fromId, a.id),
                  eq(links.toType, 'note'),
                  isNull(links.deletedAt),
                  isNull(notes.deletedAt),
                  eq(notes.aiExcluded, false)
                )
              )
              .limit(20)
              .all(),
            ...getDb()
              .select({ noteId: notes.id })
              .from(reviews)
              .innerJoin(notes, eq(notes.id, reviews.noteId))
              .where(and(eq(reviews.id, a.reviewId ?? ''), isNull(reviews.deletedAt), isNull(notes.deletedAt), eq(notes.aiExcluded, false)))
              .all()
          ].map((n) => `jiwei://note/${n.noteId}`)
        )
      ]
    })),
    limit,
    offset
  )
}

export const MistakeListInput = z.object({
  subject: MistakeSubjectSchema.optional(),
  concept: z.string().max(40).optional(),
  days: z.number().int().min(1).max(365).optional(),
  dateRange: ReadDateRange.optional(),
  mastery: z.enum(['mastered', 'unmastered', 'unknown']).optional(),
  includeMetadata: z.boolean().optional(),
  mistakeId: z.string().max(64).optional(),
  questionLimit: z.number().int().min(600).max(12000).default(600),
  limit: z.number().int().min(1).max(40).optional(),
  offset: ReadPage.offset
})
export function readMistakes(input: z.infer<typeof MistakeListInput>) {
  const { subject, concept, days, dateRange, mastery, questionLimit, offset = 0 } = input
  // 长题每页收紧，避免统一工具包装器从 JSON 中间截断。继续页仍能读取其余记录。
  const limit = Math.min(input.limit ?? 20, Math.max(1, Math.floor(14000 / (questionLimit + 1000))))
  const conds: SQL[] = [isNull(mistakes.deletedAt)]
  if (input.mistakeId) conds.push(eq(mistakes.id, input.mistakeId))
  if (subject) conds.push(eq(mistakes.subject, subject))
  if (concept) conds.push(sql`EXISTS (SELECT 1 FROM json_each(${mistakes.concepts}) WHERE value = ${concept})`)
  if (days) conds.push(gte(mistakes.createdAt, Date.now() - days * 86400000))
  if (dateRange) conds.push(gte(mistakes.createdAt, dateRange.startAt), lt(mistakes.createdAt, dateRange.endAt))
  function* candidates() {
    for (let rawOffset = 0; ; rawOffset += 100) {
      const batch = getDb()
        .select()
        .from(mistakes)
        .where(and(...conds))
        .orderBy(desc(mistakes.createdAt), mistakes.id)
        .limit(100)
        .offset(rawOffset)
        .all()
      yield* batch
      if (batch.length < 100) return
    }
  }
  const all = candidates()
  const result = []
  let skipped = 0
  for (const m of all) {
    try {
      requireMistakeCloud(m.id)
    } catch {
      continue
    }
    const state = mistakeMastery(m)
    if (mastery && state.state !== mastery) continue
    if (skipped++ < offset) continue
    result.push({
      id: m.id,
      url: m.noteId ? `jiwei://note/${m.noteId}` : null,
      noteId: m.noteId,
      rowId: m.rowId,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      subject: m.subject,
      concepts: JSON.parse(m.concepts) as string[],
      causeReason: m.causeReason.slice(0, 160),
      question: m.question.slice(0, questionLimit),
      questionTruncated: m.question.length > questionLimit,
      questionCharacters: m.question.length,
      correctAnswer: m.correctAnswer.slice(0, 300),
      mastery: state
    })
    if (result.length > limit) break
  }
  return page(result, limit, offset)
}
function mistakeMastery(m: typeof mistakes.$inferSelect) {
  const c = getDb()
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.mistakeId, m.id),
        eq(cards.kind, 'mistake'),
        eq(cards.noteId, m.noteId ?? ''),
        eq(cards.blockId, m.rowId ?? ''),
        isNull(cards.deletedAt),
        eq(cards.suspended, false)
      )
    )
    .get()
  if (!c) return { state: 'unknown', basis: 'no-active-review-card', cardId: null }
  const recall =
    c.state === State.New
      ? 0
      : fsrs(generatorParameters({ request_retention: getSettings().review.retention })).get_retrievability(
          {
            due: new Date(c.due),
            stability: c.stability,
            difficulty: c.difficulty,
            elapsed_days: c.elapsedDays,
            scheduled_days: c.scheduledDays,
            learning_steps: c.learningSteps,
            reps: c.reps,
            lapses: c.lapses,
            state: c.state as State,
            last_review: c.lastReview === null ? undefined : new Date(c.lastReview)
          },
          new Date(),
          false
        )
  return {
    state: c.state !== State.New && cardSolid(recall, c.stability) ? 'mastered' : 'unmastered',
    basis: 'current-fsrs-cardSolid',
    cardId: c.id,
    recall,
    stability: c.stability,
    lastReview: c.lastReview,
    due: c.due,
    projectedAt: Date.now()
  }
}

export function readableReferenceIds(kind: 'note' | 'source', ids: string[]): string[] {
  if (!ids.length) return []
  const table = kind === 'note' ? notes : sources
  const allowed = new Set(
    getDb()
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, ids), isNull(table.deletedAt), eq(table.aiExcluded, false)))
      .all()
      .map((r) => r.id)
  )
  return ids.filter((id) => allowed.has(id))
}
