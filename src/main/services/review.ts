import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { fsrs, generatorParameters, type Card as FsrsCard, type Grade, State } from 'ts-fsrs'
import { z } from 'zod'
import { getDb } from '../db'
import { blocks, cards, mistakes, notes, reviewLogs } from '../db/schema'
import { newId } from '../lib/ids'
import { emit } from '../events'
import { nodesToMarkdown } from '../lib/markdown'
import { embedMarkdown } from '../lib/exportFormats'
import type { AnswerCheck, DocNode, ReviewCard, ReviewRating, ReviewStats } from '@shared/types'
import { deviceId } from './device'
import { getSettings } from './settings'
import { loadDoc, stateToContent, stateToJSON } from './docs'
import { conceptsIn, recordConcept } from './learner'
import { getMemorySettings } from './memory'
import { quickModel, structured } from './ai/structured'
import { practice, check as checkMistakeAnswer, variantFor, useVariant } from './mistakesVariants'

// 复习（v0.4.0）：康奈尔笔记中有线索的每一行自动成为一张卡片——问题是线索，答案是同一行的笔记栏。
// 调度用 ts-fsrs（FSRS 官方实现）；卡片跟着行走（行删除则卡片软删除，恢复则恢复，进度保留）。
// 设计见 docs/design/v0.4-learning-loop.md §2。

type CardRow = typeof cards.$inferSelect

const DAY = 86_400_000
/** 学习中的卡片可以提前这么久拿出来（与 Anki 的 learn-ahead 相同） */
const LEARN_AHEAD = 20 * 60_000

const STATE_NAME: Record<number, ReviewCard['state']> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning'
}

function scheduler() {
  const r = getSettings().review
  return fsrs(generatorParameters({ request_retention: r.retention, enable_fuzz: true, enable_short_term: true }))
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

const fromFsrs = (c: FsrsCard) => ({
  due: c.due.getTime(),
  stability: c.stability,
  difficulty: c.difficulty,
  elapsedDays: c.elapsed_days,
  scheduledDays: c.scheduled_days,
  learningSteps: c.learning_steps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state as number,
  lastReview: c.last_review ? c.last_review.getTime() : null
})

/** 本地日期的开始（复习按自然日统计） */
const startOfDay = (t = Date.now()): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/* ————————————————— 卡片同步 ————————————————— */

/** 笔记内容或设置变化后调用：线索行 ↔ 卡片 */
export function syncCards(noteId: string): void {
  const db = getDb()
  const note = db
    .select({ kind: notes.kind, deletedAt: notes.deletedAt, reviewExcluded: notes.reviewExcluded })
    .from(notes)
    .where(eq(notes.id, noteId))
    .get()
  const now = Date.now()
  const want = new Set<string>()
  const liveRows = new Set<string>()
  const mistakeIds = new Map<string, string>()
  const invalidMistakes = new Set<string>()
  if (note && !note.deletedAt && !note.reviewExcluded && note.kind === 'cornell') {
    const doc = stateToJSON(loadDoc(noteId))
    for (const row of doc.content ?? []) {
      if (row.type === 'cornellRow' && typeof row.attrs?.id === 'string') liveRows.add(row.attrs.id)
      const id = row.type === 'cornellRow' ? row.attrs?.mistakeId : undefined
      if (typeof id !== 'string' || typeof row.attrs?.id !== 'string') continue
      const mistake = db.select().from(mistakes).where(eq(mistakes.id, id)).get()
      if (mistake && !mistake.deletedAt && mistake.noteId === noteId) mistakeIds.set(row.attrs.id, id)
      else invalidMistakes.add(row.attrs.id)
    }
    const cues = db
      .select({ rowId: blocks.rowId, text: blocks.text })
      .from(blocks)
      .where(and(eq(blocks.noteId, noteId), eq(blocks.section, 'cue'), isNull(blocks.deletedAt), isNotNull(blocks.rowId)))
      .all()
    for (const c of cues) if (c.rowId && liveRows.has(c.rowId) && !invalidMistakes.has(c.rowId) && c.text.trim().length >= 2) want.add(c.rowId)
  }
  const fields = { id: cards.id, noteId: cards.noteId, blockId: cards.blockId, deletedAt: cards.deletedAt, kind: cards.kind, mistakeId: cards.mistakeId }
  const existing = db.select(fields).from(cards).where(eq(cards.noteId, noteId)).all()
  const have = new Map(existing.map((c) => [c.blockId, c]))
  const kept = new Set<string>()
  let changed = false
  db.transaction((tx) => {
    for (const rowId of want) {
      const mistakeId = mistakeIds.get(rowId) ?? null
      // 同一道错题改学科或替换行时沿用卡片身份和FSRS，仍由此唯一派生路径写入。
      const c = have.get(rowId) ?? (mistakeId ? tx.select(fields).from(cards).where(eq(cards.mistakeId, mistakeId)).orderBy(asc(cards.createdAt)).get() : undefined)
      const kind = mistakeId ? 'mistake' as const : 'cornell' as const
      if (!c) {
        tx.insert(cards)
          .values({ id: newId(), noteId, blockId: rowId, kind, mistakeId, due: now, createdAt: now, updatedAt: now, updatedBy: deviceId() })
          .onConflictDoNothing()
          .run()
        changed = true
      } else {
        kept.add(c.id)
        if (c.deletedAt || c.kind !== kind || c.mistakeId !== mistakeId || c.noteId !== noteId || c.blockId !== rowId) {
          tx.update(cards).set({ noteId, blockId: rowId, deletedAt: null, kind, mistakeId, updatedAt: now }).where(eq(cards.id, c.id)).run()
          changed = true
        }
      }
    }
    for (const c of existing)
      if (!c.deletedAt && !kept.has(c.id)) {
        tx.update(cards).set({ deletedAt: now, updatedAt: now }).where(eq(cards.id, c.id)).run()
        changed = true
      }
  })
  if (changed) emit('review:changed', {})
}

/** 启动时补齐（例如从 v0.3 升级：已有的线索第一次成为卡片） */
export function syncAllCards(): void {
  const ids = getDb()
    .select({ id: notes.id })
    .from(notes)
    .where(and(isNull(notes.deletedAt), eq(notes.kind, 'cornell')))
    .all()
  for (const { id } of ids) syncCards(id)
}

/* ————————————————— 队列 ————————————————— */

/** 可复习的卡片：未删除、未暂停、笔记未删除且未设为不复习 */
const activeWhere = () =>
  and(isNull(cards.deletedAt), eq(cards.suspended, false), isNull(notes.deletedAt), eq(notes.reviewExcluded, false))

function newIntroducedToday(): number {
  return (
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(reviewLogs)
      .where(and(eq(reviewLogs.state, State.New), gte(reviewLogs.reviewedAt, startOfDay())))
      .get()?.n ?? 0
  )
}

function counts(now = Date.now()) {
  const db = getDb()
  const endOfDay = startOfDay(now) + DAY
  const base = db.select({ n: sql<number>`count(*)` }).from(cards).innerJoin(notes, eq(notes.id, cards.noteId))
  const n = (where: ReturnType<typeof and>): number => base.where(and(activeWhere(), where)).get()?.n ?? 0
  const learningNow = n(and(inArray(cards.state, [State.Learning, State.Relearning]), lte(cards.due, now + LEARN_AHEAD)))
  const reviewDue = n(and(eq(cards.state, State.Review), lte(cards.due, endOfDay)))
  const newCards = n(eq(cards.state, State.New))
  const quota = Math.max(0, getSettings().review.newPerDay - newIntroducedToday())
  const laterToday = n(and(inArray(cards.state, [State.Learning, State.Relearning]), sql`${cards.due} > ${now + LEARN_AHEAD}`, lte(cards.due, endOfDay)))
  const tomorrow = n(and(sql`${cards.due} > ${endOfDay}`, lte(cards.due, endOfDay + DAY), sql`${cards.state} != ${State.New}`))
  return { learningNow, reviewDue, newCards, newToday: Math.min(quota, newCards), laterToday, tomorrow }
}

function cardRows(where: ReturnType<typeof and>, order: ReturnType<typeof asc>[], limit: number): CardRow[] {
  return getDb()
    .select({ c: cards })
    .from(cards)
    .innerJoin(notes, eq(notes.id, cards.noteId))
    .where(and(activeWhere(), where))
    .orderBy(...order)
    .limit(limit)
    .all()
    .map((r) => r.c)
}

/**
 * 下一张卡片：学习中且到期的 → 今天到期的复习卡 → 新卡（不超过每日上限）→ 20 分钟内到期的学习中卡片。
 * exclude：本轮刚复习过的（避免同一张连续出现）。
 */
export function nextCard(exclude: string[] = []): ReviewCard | null {
  const now = Date.now()
  const endOfDay = startOfDay(now) + DAY
  const notIn = exclude.length ? sql`${cards.id} NOT IN (${sql.join(exclude.map((e) => sql`${e}`), sql`, `)})` : sql`1 = 1`
  const learning = and(inArray(cards.state, [State.Learning, State.Relearning]), notIn)
  const pick =
    cardRows(and(learning, lte(cards.due, now)), [asc(cards.due)], 1)[0] ??
    cardRows(and(eq(cards.state, State.Review), lte(cards.due, endOfDay), notIn), [asc(cards.due)], 1)[0] ??
    (counts(now).newToday > 0 ? cardRows(and(eq(cards.state, State.New), notIn), [asc(cards.createdAt)], 1)[0] : undefined) ??
    cardRows(and(learning, lte(cards.due, now + LEARN_AHEAD)), [asc(cards.due)], 1)[0] ??
    // 只剩刚复习过的学习中卡片：也可以再来一次
    (exclude.length ? cardRows(and(inArray(cards.state, [State.Learning, State.Relearning]), lte(cards.due, now + LEARN_AHEAD)), [asc(cards.due)], 1)[0] : undefined)
  return pick ? toReviewCard(pick) : null
}

/* ————————————————— 卡片内容 ————————————————— */

function rowContent(noteId: string, rowId: string): { question: string; answer: string } | null {
  const { doc, embeds } = stateToContent(loadDoc(noteId))
  const zh = getSettings().language.startsWith('zh')
  const row = doc.content?.find((n) => n.type === 'cornellRow' && n.attrs?.id === rowId)
  if (!row) return null
  const cue = row.content?.find((c) => c.type === 'cornellCue')?.content ?? []
  const body = row.content?.find((c) => c.type === 'cornellBody')?.content ?? []
  const answer = body
    .map((n: DocNode) => {
      if (n.type === 'embed') {
        const e = embeds[String(n.attrs?.id ?? '')]
        return e?.kind ? embedMarkdown(e.kind, e.data, zh) : ''
      }
      return nodesToMarkdown([n])
    })
    .filter((s) => s.trim())
    .join('\n\n')
  return { question: nodesToMarkdown(cue).trim(), answer }
}

function toReviewCard(c: CardRow): ReviewCard {
  const note = getDb().select({ title: notes.title }).from(notes).where(eq(notes.id, c.noteId)).get()
  const content = rowContent(c.noteId, c.blockId) ?? { question: '', answer: '' }
  const exercise = c.kind === 'mistake' && c.mistakeId ? practice(c.mistakeId) : null
  const preview = scheduler().repeat(toFsrs(c), new Date())
  const next = Object.fromEntries(([1, 2, 3, 4] as const).map((g) => [g, preview[g as Grade].card.due.getTime()])) as ReviewCard['next']
  return {
    id: c.id,
    noteId: c.noteId,
    noteTitle: note?.title ?? '',
    rowId: c.blockId,
    kind: c.kind,
    mistakeId: c.mistakeId,
    variantId: exercise?.variantId ?? null,
    original: exercise ? content : null,
    variantFallback: exercise?.fallback ?? null,
    question: exercise?.variantId ? exercise.question : content.question,
    answer: exercise?.variantId ? [exercise.answer, exercise.solution].filter(Boolean).join('\n\n') : content.answer,
    state: STATE_NAME[c.state] ?? 'new',
    due: c.due,
    reps: c.reps,
    lapses: c.lapses,
    lastReview: c.lastReview,
    next
  }
}

export function getCard(id: string): ReviewCard | null {
  const c = getDb().select().from(cards).where(eq(cards.id, id)).get()
  return c ? toReviewCard(c) : null
}

/** 笔记中某一行的卡片（编辑器中显示复习状态用） */
export function cardsForNote(noteId: string): { id: string; rowId: string; state: ReviewCard['state']; due: number; suspended: boolean }[] {
  return getDb()
    .select({ id: cards.id, rowId: cards.blockId, state: cards.state, due: cards.due, suspended: cards.suspended })
    .from(cards)
    .where(and(eq(cards.noteId, noteId), isNull(cards.deletedAt)))
    .all()
    .map((c) => ({ ...c, state: STATE_NAME[c.state] ?? 'new' }))
}

/* ————————————————— 评分 ————————————————— */

export function rate(id: string, rating: ReviewRating, durationMs?: number, variantId?: string | null): ReviewCard | null {
  const db = getDb()
  const c = db.select().from(cards).where(eq(cards.id, id)).get()
  if (!c) throw new Error('Card not found')
  const selectedVariant = c.kind === 'mistake' && c.mistakeId ? (variantId === undefined ? practice(c.mistakeId).variantId : variantId) : null
  if (c.mistakeId && selectedVariant) variantFor(c.mistakeId, selectedVariant)
  const now = new Date()
  const { card, log } = scheduler().next(toFsrs(c), now, rating as Grade)
  db.transaction((tx) => {
    tx.update(cards)
      .set({ ...fromFsrs(card), updatedAt: now.getTime(), updatedBy: deviceId() })
      .where(eq(cards.id, id))
      .run()
    tx.insert(reviewLogs)
      .values({
        id: newId(),
        cardId: id,
        rating: log.rating,
        state: log.state,
        due: log.due.getTime(),
        stability: log.stability,
        difficulty: log.difficulty,
        elapsedDays: log.elapsed_days,
        scheduledDays: log.scheduled_days,
        durationMs: durationMs ?? null,
        reviewedAt: now.getTime()
      })
      .run()
    if (selectedVariant) useVariant(selectedVariant)
  })
  // 学习者模型：问题中出现的已知概念
  if (rating !== 2 && getMemorySettings().autoLearn) {
    const q = rowContent(c.noteId, c.blockId)?.question ?? ''
    for (const k of conceptsIn(q, 3)) recordConcept(k.name, rating === 1 ? 'confused' : 'understood', {}, { silent: true })
  }
  emit('review:changed', {})
  return getCard(id)
}

/** 撤销这张卡片最近一次评分（恢复到评分前的调度状态） */
export function undoRating(id: string): ReviewCard | null {
  const db = getDb()
  const last = db.select().from(reviewLogs).where(eq(reviewLogs.cardId, id)).orderBy(sql`${reviewLogs.reviewedAt} DESC`).limit(1).get()
  const c = db.select().from(cards).where(eq(cards.id, id)).get()
  if (!last || !c) return c ? toReviewCard(c) : null
  const prevLog = db
    .select()
    .from(reviewLogs)
    .where(and(eq(reviewLogs.cardId, id), sql`${reviewLogs.id} != ${last.id}`))
    .orderBy(sql`${reviewLogs.reviewedAt} DESC`)
    .limit(1)
    .get()
  // 评分前的状态：卡片字段来自日志（FSRS 日志记录的是评分前的值；学习阶段步数未记录，回到第一步）
  db.transaction((tx) => {
    tx.update(cards)
      .set({
        due: last.due,
        stability: last.stability,
        difficulty: last.difficulty,
        elapsedDays: last.elapsedDays,
        scheduledDays: last.scheduledDays,
        state: last.state,
        reps: Math.max(0, c.reps - 1),
        lapses: last.rating === 1 && last.state === State.Review ? Math.max(0, c.lapses - 1) : c.lapses,
        learningSteps: 0,
        lastReview: prevLog?.reviewedAt ?? null,
        updatedAt: Date.now()
      })
      .where(eq(cards.id, id))
      .run()
    tx.delete(reviewLogs).where(eq(reviewLogs.id, last.id)).run()
  })
  emit('review:changed', {})
  return getCard(id)
}

export function suspendCard(id: string, suspended: boolean): void {
  getDb().update(cards).set({ suspended, updatedAt: Date.now() }).where(eq(cards.id, id)).run()
  emit('review:changed', {})
}

/* ————————————————— 统计 ————————————————— */

export function reviewStats(): ReviewStats {
  const db = getDb()
  const now = Date.now()
  const k = counts(now)
  const today = startOfDay(now)
  const reviewedToday =
    db
      .select({ n: sql<number>`count(*)` })
      .from(reviewLogs)
      .where(gte(reviewLogs.reviewedAt, today))
      .get()?.n ?? 0
  // 连续天数：从今天（今天还没复习则从昨天）往前数
  const days = new Set(
    (
      db
        .select({ at: reviewLogs.reviewedAt })
        .from(reviewLogs)
        .where(gte(reviewLogs.reviewedAt, today - 400 * DAY))
        .all() as { at: number }[]
    ).map((r) => startOfDay(r.at))
  )
  let streak = 0
  for (let d = days.has(today) ? today : today - DAY; days.has(d); d -= DAY) streak++
  const recent = db
    .select({ rating: reviewLogs.rating })
    .from(reviewLogs)
    .where(and(eq(reviewLogs.state, State.Review), gte(reviewLogs.reviewedAt, now - 30 * DAY)))
    .all()
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(cards)
      .innerJoin(notes, eq(notes.id, cards.noteId))
      .where(activeWhere())
      .get()?.n ?? 0
  const suspended =
    db
      .select({ n: sql<number>`count(*)` })
      .from(cards)
      .where(and(isNull(cards.deletedAt), eq(cards.suspended, true)))
      .get()?.n ?? 0
  return {
    due: k.learningNow + k.reviewDue + k.newToday,
    dueReview: k.reviewDue + k.learningNow,
    newToday: k.newToday,
    reviewedToday,
    streak,
    retention: recent.length ? recent.filter((r) => r.rating > 1).length / recent.length : null,
    total,
    suspended,
    tomorrow: k.tomorrow,
    laterToday: k.laterToday
  }
}

/* ————————————————— AI 检查回答 ————————————————— */

const CheckSchema = z.object({
  verdict: z.string().max(300).describe('一两句总体评价'),
  missing: z.array(z.string().max(200)).max(5).describe('回答中遗漏的要点'),
  wrong: z.array(z.string().max(200)).max(5).describe('说错或不准确的地方'),
  suggested: z.number().int().min(1).max(4).describe('建议评分：1 忘了 2 困难 3 记得 4 轻松')
})

export async function checkAnswer(id: string, answer: string, variantId?: string | null): Promise<AnswerCheck> {
  const c = getDb().select().from(cards).where(eq(cards.id, id)).get()
  if (!c) throw new Error('Card not found')
  if (c.kind === 'mistake' && c.mistakeId) return checkMistakeAnswer(c.mistakeId, variantId === undefined ? practice(c.mistakeId).variantId : variantId, answer)
  const note = getDb().select({ aiExcluded: notes.aiExcluded }).from(notes).where(eq(notes.id, c.noteId)).get()
  const zh = getSettings().language.startsWith('zh')
  if (note?.aiExcluded) throw new Error(zh ? '这篇笔记设为“不发送给 AI”' : 'This note is excluded from AI')
  const s = getSettings()
  if (!s.ai.chat.providerId || !s.ai.chat.model) throw new Error(zh ? '还没有设置 AI 模型' : 'No AI model configured')
  const content = rowContent(c.noteId, c.blockId)
  if (!content) throw new Error('Card content not found')
  const out = await structured({
    providerId: s.ai.chat.providerId,
    model: quickModel(s.ai.chat.providerId, s.ai.chat.model),
    system: zh
      ? `你在帮用户做主动回忆练习。对照“笔记中的答案”，检查“用户的回答”：
- 只看意思是否到位，不要求措辞一致；用自己的话说对了就算对。
- missing 列出笔记中重要但用户没提到的要点；wrong 列出说错的地方；没有就留空。
- suggested：基本没答出 = 1；答出一部分或有明显错误 = 2；要点都对 = 3；完整准确且毫不费力 = 4。
- verdict 用一两句话，像一位耐心的老师，先肯定说对的部分。用简体中文。`
      : `You help the user practise active recall. Compare the user's answer with the note's answer:
- Judge meaning, not wording.
- missing: important points the user left out; wrong: mistakes. Leave empty if none.
- suggested: 1 barely recalled; 2 partial or with clear errors; 3 all key points; 4 complete and effortless.
- verdict: one or two sentences, like a patient teacher; start with what was right.`,
    prompt: `${zh ? '问题' : 'Question'}：${content.question}\n\n${zh ? '笔记中的答案' : 'Answer in the note'}：\n${content.answer.slice(0, 4000)}\n\n${zh ? '用户的回答' : "User's answer"}：\n${answer.slice(0, 3000)}`,
    schema: CheckSchema
  })
  return { ...out, suggested: out.suggested as ReviewRating }
}
