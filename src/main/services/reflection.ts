import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { actions, blocks, cards, conversations, insightVersions, insights, links, notes, reviewLogs, reviews } from '../db/schema'
import { profileDb } from '../db/profile'
import { newId } from '../lib/ids'
import { markdownToNodes } from '../lib/markdown'
import { masteryLevel } from '../lib/learner'
import { emit } from '../events'
import type {
  ActionItem,
  DocJSON,
  DocNode,
  Insight,
  InsightConfidence,
  InsightVersion,
  Reflection,
  ReflectionHarvest,
  ReflectionKind,
  ReflectionMaterial,
  ReflectionOverview
} from '@shared/types'
import type { HarvestCommit, ReflectionStart } from '@shared/schemas'
import { deviceId } from './device'
import { getSettings } from './settings'
import { createNote, getNote, listNotes, trashNote } from './notes'
import { loadDoc, replaceDoc, stateToContent } from './docs'
import { nodeText } from '../lib/derive'
import { parseMeta } from './feynman'
import { structured } from './ai/structured'
import { goalProgress, listGoals } from './progress'
import { recentAnnotations } from './annotations'

// 复盘（v0.4.2）：每日 1 分钟微复盘、每周完整复盘（GRAI）、专题复盘（主题 / 实践 / 认知变化）。
// 复盘正文是一篇 kind = review 的康奈尔笔记：线索栏是引导问题，笔记栏是你的回答，总结栏写最重要的一点。
// 素材包由数据统计生成（不经过 AI）；AI 只做苏格拉底式追问（不替你写结论），以及在你完成时提炼洞见与行动项供你确认。
// 洞见有版本、依据与把握程度——被修正时留下原因，形成认知成长轨迹；行动项在下一次复盘时检查是否完成。
// 设计见 docs/design/v0.4-learning-loop.md §4。

const DAY = 86_400_000
const zhUI = (): boolean => getSettings().language.startsWith('zh')
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

export const startOfDay = (t = Date.now()): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
/** 一周从周一开始（本地时间） */
export const startOfWeek = (t = Date.now()): number => {
  const d = new Date(startOfDay(t))
  const back = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - back)
  return d.getTime()
}
const addDays = (t: number, n: number): number => {
  const d = new Date(t)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/* ————————————————— 模板 ————————————————— */

const QUESTIONS: Record<ReflectionKind, [string[], string[]]> = {
  daily: [
    ['今天学了什么？', '还有什么没想明白？', '明天做一件什么事？'],
    ['What did I learn today?', 'What is still unclear?', 'One thing to do tomorrow?']
  ],
  weekly: [
    [
      '目标：这周原本想学会什么？',
      '结果：实际学会了什么？和目标比怎样？',
      '分析：哪些做法有效，哪些没用？为什么？',
      '洞见：这周最重要的一个认识是什么？',
      '行动：下周具体做什么？'
    ],
    [
      'Goal: what did I set out to learn this week?',
      'Result: what did I actually learn, compared with the goal?',
      'Analysis: what worked, what did not, and why?',
      'Insight: the most important realisation this week?',
      'Action: what exactly will I do next week?'
    ]
  ],
  topic: [
    ['用自己的话说，这个主题的核心是什么？', '它和我已有的知识有什么联系？', '还有哪些疑问？', '我能用它做什么？'],
    ['In my own words, what is the core of this topic?', 'How does it connect to what I already know?', 'What questions remain?', 'What can I use it for?']
  ],
  practice: [
    ['预期：原本希望发生什么？', '实际：真正发生了什么？', '原因：差距从哪里来？', '下次：我会怎么做？'],
    ['Expected: what did I hope would happen?', 'Actual: what really happened?', 'Cause: where did the gap come from?', 'Next time: what will I do?']
  ],
  belief: [
    ['我原来怎么想？', '现在怎么想？', '是什么让我改变了？（证据）', '把握有多大？还需要什么来验证？'],
    ['What did I used to think?', 'What do I think now?', 'What changed my mind? (evidence)', 'How sure am I? What would confirm it?']
  ]
}

export function questions(kind: ReflectionKind, zh = zhUI()): string[] {
  return QUESTIONS[kind][zh ? 0 : 1]
}

const p = (text: string): DocNode => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })

function templateDoc(qs: string[], answers: string[] = []): DocJSON {
  return {
    type: 'doc',
    content: [
      ...qs.map((q, i) => ({
        type: 'cornellRow',
        content: [
          { type: 'cornellCue', content: [p(q)] },
          { type: 'cornellBody', content: answers[i]?.trim() ? markdownToNodes(answers[i]) : [p('')] }
        ]
      })),
      { type: 'cornellSummary', content: [p('')] }
    ]
  }
}

function fmtDay(t: number, zh: boolean): string {
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', { month: 'long', day: 'numeric' }).format(new Date(t))
}

function titleFor(kind: ReflectionKind, start: number, scopeTitle: string | null, zh: boolean): string {
  switch (kind) {
    case 'daily':
      return zh ? `微复盘 · ${fmtDay(start, zh)}` : `Daily reflection · ${fmtDay(start, zh)}`
    case 'weekly':
      return zh ? `周复盘 · ${fmtDay(start, zh)}–${fmtDay(addDays(start, 6), zh)}` : `Weekly review · ${fmtDay(start, zh)}–${fmtDay(addDays(start, 6), zh)}`
    case 'topic':
      return zh ? `主题复盘：${scopeTitle ?? ''}` : `Topic review: ${scopeTitle ?? ''}`
    case 'practice':
      return zh ? `实践复盘：${scopeTitle ?? ''}` : `Practice review: ${scopeTitle ?? ''}`
    case 'belief':
      return zh ? `认知变化：${scopeTitle ?? ''}` : `Belief change: ${scopeTitle ?? ''}`
  }
}

/* ————————————————— 复盘 ————————————————— */

type ReviewRow = typeof reviews.$inferSelect

function toReflection(r: ReviewRow): Reflection {
  const note = r.noteId ? getNote(r.noteId) : null
  return {
    id: r.id,
    kind: r.kind as ReflectionKind,
    noteId: note ? r.noteId : null,
    title: note?.title ?? '',
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    scope: r.scope ? (JSON.parse(r.scope) as Reflection['scope']) : null,
    status: r.status,
    completedAt: r.completedAt,
    createdAt: r.createdAt
  }
}

export function getReflection(id: string): Reflection | null {
  const r = getDb().select().from(reviews).where(eq(reviews.id, id)).get()
  return r && !r.deletedAt ? toReflection(r) : null
}

function findPeriod(kind: 'daily' | 'weekly', start: number): ReviewRow | undefined {
  return getDb()
    .select()
    .from(reviews)
    .where(and(eq(reviews.kind, kind), eq(reviews.periodStart, start), isNull(reviews.deletedAt)))
    .get()
}

/** 开始一次复盘：每日 / 每周按时间段只有一份（已存在则返回）；专题复盘每次新建 */
export function startReflection(input: ReflectionStart): Reflection {
  const zh = zhUI()
  const now = Date.now()
  let start: number | null = null
  let end: number | null = null
  if (input.kind === 'daily') {
    start = startOfDay(now)
    end = start + DAY
  } else if (input.kind === 'weekly') {
    start = startOfWeek(now)
    end = addDays(start, 7)
  }
  if ((input.kind === 'daily' || input.kind === 'weekly') && start !== null) {
    const existing = findPeriod(input.kind, start)
    if (existing && existing.noteId && getNote(existing.noteId)) return toReflection(existing)
  }
  const scopeTitle = input.topic?.trim() || null
  const note = createNote({ kind: 'review', title: titleFor(input.kind, start ?? now, scopeTitle, zh), categoryId: input.categoryId ?? null })
  replaceDoc(note.id, templateDoc(questions(input.kind, zh)))
  const id = newId()
  getDb()
    .insert(reviews)
    .values({
      id,
      noteId: note.id,
      kind: input.kind,
      periodStart: start,
      periodEnd: end,
      scope:
        input.topic || input.categoryId || input.tagId
          ? JSON.stringify({ topic: input.topic, categoryId: input.categoryId, tagId: input.tagId })
          : null,
      template: input.kind === 'weekly' ? 'grai' : input.kind,
      createdAt: now,
      updatedAt: now,
      updatedBy: deviceId()
    })
    .run()
  emit('reflection:changed', {})
  return getReflection(id)!
}

/** 删除复盘：复盘笔记进入最近删除（可恢复） */
export function removeReflection(id: string): void {
  const r = getDb().select().from(reviews).where(eq(reviews.id, id)).get()
  if (!r) return
  if (r.noteId) trashNote(r.noteId)
  getDb().update(reviews).set({ deletedAt: Date.now(), updatedAt: Date.now() }).where(eq(reviews.id, id)).run()
  emit('reflection:changed', {})
}

export function listReflections(limit = 30): Reflection[] {
  return getDb()
    .select()
    .from(reviews)
    .where(isNull(reviews.deletedAt))
    .orderBy(desc(reviews.createdAt))
    .limit(limit)
    .all()
    .map(toReflection)
    .filter((r) => r.noteId)
}

export function reflectionOverview(): ReflectionOverview {
  const now = Date.now()
  const day = findPeriod('daily', startOfDay(now))
  const week = findPeriod('weekly', startOfWeek(now))
  return {
    today: day ? toReflection(day) : null,
    week: week ? toReflection(week) : null,
    weekStart: startOfWeek(now),
    weekEnd: addDays(startOfWeek(now), 7),
    recent: listReflections(20),
    openActions: listActions('open'),
    insights:
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(insights)
        .where(and(isNull(insights.deletedAt), eq(insights.status, 'active')))
        .get()?.n ?? 0
  }
}

/** 复盘正文：各引导问题与回答（AI 追问与提炼用） */
export function reflectionText(id: string): string {
  const r = getReflection(id)
  if (!r?.noteId) return ''
  const { doc } = stateToContent(loadDoc(r.noteId))
  const zh = zhUI()
  const out: string[] = []
  for (const top of doc.content ?? []) {
    if (top.type === 'cornellRow') {
      const cue = nodeText({ type: 'doc', content: top.content?.find((c) => c.type === 'cornellCue')?.content ?? [] }).trim()
      const body = nodeText({ type: 'doc', content: top.content?.find((c) => c.type === 'cornellBody')?.content ?? [] }).trim()
      if (cue || body) out.push(`【${cue || (zh ? '（无题）' : '(untitled)')}】\n${body || (zh ? '（还没写）' : '(empty)')}`)
    } else if (top.type === 'cornellSummary') {
      const s = nodeText(top).trim()
      if (s) out.push(`【${zh ? '总结' : 'Summary'}】\n${s}`)
    }
  }
  return out.join('\n\n')
}

/** 各引导问题下的回答（每日微复盘表单回填用） */
export function reflectionAnswers(id: string): string[] {
  const r = getReflection(id)
  if (!r?.noteId) return []
  const { doc } = stateToContent(loadDoc(r.noteId))
  return (doc.content ?? [])
    .filter((n) => n.type === 'cornellRow')
    .map((row) => nodeText({ type: 'doc', content: row.content?.find((c) => c.type === 'cornellBody')?.content ?? [] }).trim())
}

/* ————————————————— 每日微复盘 ————————————————— */

/** 1 分钟微复盘：三个回答写进当天的复盘笔记；“明天做一件事”成为明天到期的行动项 */
export function saveDaily(answers: string[]): Reflection {
  const zh = zhUI()
  const r = startReflection({ kind: 'daily' })
  replaceDoc(r.noteId!, templateDoc(questions('daily', zh), answers))
  const db = getDb()
  const now = Date.now()
  const todo = answers[2]?.trim()
  if (todo) {
    // 再次保存时替换当天复盘生成的行动项，不重复
    db.delete(actions).where(and(eq(actions.reviewId, r.id), eq(actions.status, 'open'))).run()
    db.insert(actions)
      .values({ id: newId(), title: clip(todo, 300), dueAt: startOfDay(now) + 2 * DAY - 1, reviewId: r.id, createdAt: now, updatedAt: now, updatedBy: deviceId() })
      .run()
  }
  db.update(reviews).set({ status: 'done', completedAt: now, updatedAt: now }).where(eq(reviews.id, r.id)).run()
  emit('reflection:changed', {})
  return getReflection(r.id)!
}

/* ————————————————— 素材包 ————————————————— */

export function reflectionMaterial(id: string): ReflectionMaterial {
  const r = getReflection(id)
  if (!r) throw new Error('Reflection not found')
  const db = getDb()
  const zh = zhUI()
  const now = Date.now()
  // 专题复盘看最近 30 天
  const start = r.periodStart ?? now - 30 * DAY
  const end = r.periodEnd ?? now + 1

  // 笔记：期间创建或编辑过的（复盘笔记本身除外）；专题复盘只看范围内的
  let scoped: string[] | null = null
  if (r.scope?.categoryId || r.scope?.tagId || r.scope?.topic) {
    const list = r.scope.categoryId
      ? listNotes({ categoryId: r.scope.categoryId, includeDescendants: true })
      : r.scope.tagId
        ? listNotes({ tagId: r.scope.tagId })
        : listNotes({ search: r.scope.topic })
    scoped = list.filter((n) => n.kind === 'cornell').map((n) => n.id)
  }
  const noteRows = db
    .select({ id: notes.id, title: notes.title, editedAt: notes.editedAt, createdAt: notes.createdAt })
    .from(notes)
    .where(
      and(
        isNull(notes.deletedAt),
        eq(notes.kind, 'cornell'),
        scoped ? inArray(notes.id, scoped.length ? scoped : ['-']) : or(and(gte(notes.editedAt, start), lt(notes.editedAt, end)), and(gte(notes.createdAt, start), lt(notes.createdAt, end)))
      )
    )
    .orderBy(desc(notes.editedAt))
    .limit(40)
    .all()
  const noteIds = noteRows.map((n) => n.id)

  // 学习经历（个人数据库）
  const episodes = (
    profileDb()
      .prepare("SELECT content, updated_at, evidence FROM memories WHERE kind = 'episode' AND status = 'active' AND updated_at >= ? AND updated_at < ? ORDER BY updated_at DESC LIMIT 20")
      .all(start, end) as { content: string; updated_at: number; evidence: string | null }[]
  ).map((e) => ({
    content: e.content,
    at: e.updated_at,
    conversationId: e.evidence ? ((JSON.parse(e.evidence) as { conversationId?: string }).conversationId ?? null) : null
  }))

  // 复习表现：期间复习次数、忘记次数、忘得最多的卡片
  const logs = db
    .select({ cardId: reviewLogs.cardId, rating: reviewLogs.rating })
    .from(reviewLogs)
    .where(and(gte(reviewLogs.reviewedAt, start), lt(reviewLogs.reviewedAt, end)))
    .all()
  const forgotBy = new Map<string, number>()
  for (const l of logs) if (l.rating === 1) forgotBy.set(l.cardId, (forgotBy.get(l.cardId) ?? 0) + 1)
  const hardIds = [...forgotBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const hardest = hardIds
    .map(([cardId, n]) => {
      const c = db.select({ noteId: cards.noteId, rowId: cards.blockId }).from(cards).where(eq(cards.id, cardId)).get()
      if (!c) return null
      const cue = db
        .select({ text: blocks.text })
        .from(blocks)
        .where(and(eq(blocks.rowId, c.rowId), eq(blocks.section, 'cue'), isNull(blocks.deletedAt)))
        .all()
        .map((b) => b.text)
        .join(' ')
      return cue ? { question: clip(cue, 120), noteId: c.noteId, lapses: n } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)

  // 有线索、笔记栏还空着的行
  const unanswered: ReflectionMaterial['unanswered'] = []
  if (noteIds.length) {
    const rows = db
      .select({ noteId: blocks.noteId, rowId: blocks.rowId, section: blocks.section, text: blocks.text })
      .from(blocks)
      .where(and(inArray(blocks.noteId, noteIds), isNull(blocks.deletedAt), inArray(blocks.section, ['cue', 'body'])))
      .all()
    const byRow = new Map<string, { noteId: string; cue: string; body: string }>()
    for (const b of rows) {
      if (!b.rowId) continue
      const e = byRow.get(b.rowId) ?? { noteId: b.noteId, cue: '', body: '' }
      if (b.section === 'cue') e.cue += b.text
      else e.body += b.text
      byRow.set(b.rowId, e)
    }
    for (const e of byRow.values())
      if (e.cue.trim() && !e.body.trim())
        unanswered.push({ question: clip(e.cue.trim(), 120), noteId: e.noteId, noteTitle: noteRows.find((n) => n.id === e.noteId)?.title ?? '' })
  }

  // 概念掌握度变化（期间有信号的概念）
  const concepts = (
    profileDb()
      .prepare(
        `SELECT c.name, c.mastery, c.first_seen,
           SUM(CASE WHEN e.type = 'understood' THEN 1 ELSE 0 END) AS up,
           SUM(CASE WHEN e.type != 'understood' THEN 1 ELSE 0 END) AS down
         FROM concept_events e JOIN concepts c ON c.id = e.concept_id
         WHERE e.at >= ? AND e.at < ? GROUP BY c.id ORDER BY MAX(e.at) DESC LIMIT 20`
      )
      .all(start, end) as { name: string; mastery: number; first_seen: number; up: number; down: number }[]
  ).map((c) => ({
    name: c.name,
    level: masteryLevel(c.mastery),
    change: (c.first_seen >= start ? 'new' : c.up >= c.down ? 'up' : 'down') as 'up' | 'down' | 'new'
  }))
  if (r.scope?.topic) {
    const key = r.scope.topic.toLowerCase()
    concepts.sort((a, b) => Number(b.name.toLowerCase().includes(key)) - Number(a.name.toLowerCase().includes(key)))
  }

  // 费曼练习
  const feynman = db
    .select({ id: conversations.id, meta: conversations.meta })
    .from(conversations)
    .where(and(eq(conversations.kind, 'feynman'), isNull(conversations.deletedAt), gte(conversations.updatedAt, start), lt(conversations.updatedAt, end)))
    .all()
    .map((c) => {
      const m = parseMeta(c.meta)
      return m ? { concept: m.concept, level: m.report?.level ?? null, conversationId: c.id } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)

  // 行动项：到期未完成的（含更早的）+ 期间完成的
  const acts = db
    .select()
    .from(actions)
    .where(
      and(
        isNull(actions.deletedAt),
        or(isNull(actions.reviewId), ne(actions.reviewId, id)),
        or(and(eq(actions.status, 'open'), lte(actions.dueAt, end)), and(gte(actions.doneAt, start), lt(actions.doneAt, end)))
      )
    )
    .orderBy(asc(actions.dueAt))
    .all()
    .map(toAction)

  const goalList = listGoals()
    .filter((g) => g.status === 'active')
    .slice(0, 6)
    .map((g) => {
      const p = goalProgress(g.id)
      return { id: g.id, title: g.title, mastered: p.mastered, reviews7d: p.reviews7d, daysLeft: p.daysLeft }
    })

  // 期间新增的批注：评论、存疑（存疑即未解决的问题）、高亮数量
  const anns = recentAnnotations(start, end - 1)
  const annotationsOut: ReflectionMaterial['annotations'] = {
    highlights: anns.length,
    items: anns
      .filter((a) => a.body?.trim() || a.motivation === 'questioning')
      .slice(0, 30)
      .map((a) => ({
        id: a.id,
        targetType: a.targetType,
        targetId: a.targetId,
        targetTitle: a.targetTitle,
        quote: a.selector.quote ? clip(a.selector.quote, 160) : null,
        body: a.body,
        question: a.motivation === 'questioning',
        page: a.selector.page ?? null,
        ownerId: a.selector.ownerId ?? null
      }))
  }

  const L = (zhText: string, en: string): string => (zh ? zhText : en)
  const text = [
    `${L('时间', 'Period')}：${new Date(start).toLocaleDateString()} – ${new Date(end - 1).toLocaleDateString()}`,
    r.scope?.topic ? `${L('主题', 'Topic')}：${r.scope.topic}` : '',
    noteRows.length ? `${L('学习的笔记', 'Notes')}：${noteRows.map((n) => `《${n.title || L('无标题', 'Untitled')}》`).join('、')}` : '',
    episodes.length ? `${L('学习经历', 'Study log')}：\n${episodes.map((e) => `- ${clip(e.content, 200)}`).join('\n')}` : '',
    logs.length
      ? `${L('复习', 'Reviews')}：${L(`复习 ${logs.length} 次，忘记 ${logs.filter((l) => l.rating === 1).length} 次`, `${logs.length} reviews, forgot ${logs.filter((l) => l.rating === 1).length}`)}${hardest.length ? `；${L('忘得最多', 'Hardest')}：${hardest.map((h) => h.question).join('；')}` : ''}`
      : '',
    unanswered.length ? `${L('还没回答的线索', 'Unanswered cues')}：${unanswered.slice(0, 8).map((u) => u.question).join('；')}` : '',
    concepts.length ? `${L('概念掌握', 'Concepts')}：${concepts.map((c) => `${c.name}（${c.level}，${c.change}）`).join('、')}` : '',
    feynman.length ? `${L('费曼练习', 'Feynman practice')}：${feynman.map((f) => `${f.concept}（${f.level ?? '-'}）`).join('、')}` : '',
    acts.length ? `${L('行动项', 'Actions')}：${acts.map((a) => `${a.title}（${a.status}）`).join('；')}` : '',
    annotationsOut.items.length
      ? `${L('批注', 'Annotations')}（${L(`共 ${anns.length} 处`, `${anns.length} in total`)}）：\n${annotationsOut.items
          .map((a) => `- ${a.question ? L('［存疑］', '[Question] ') : ''}《${a.targetTitle}》${a.quote ? `“${a.quote}”` : ''}${a.body ? `：${clip(a.body, 200)}` : ''}`)
          .join('\n')}`
      : '',
    goalList.length
      ? `${L('学习目标', 'Goals')}：${goalList.map((g) => `${g.title}（${L('掌握', 'mastered')} ${Math.round(g.mastered * 100)}%${g.daysLeft !== null ? `，${L(`剩 ${g.daysLeft} 天`, `${g.daysLeft} days left`)}` : ''}）`).join('；')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n')

  return {
    period: { start, end },
    notes: noteRows.map((n) => ({ id: n.id, title: n.title, editedAt: n.editedAt, created: n.createdAt >= start })),
    episodes,
    review: { reviewed: logs.length, forgot: logs.filter((l) => l.rating === 1).length, hardest },
    unanswered: unanswered.slice(0, 20),
    concepts,
    feynman,
    actions: acts,
    goals: goalList,
    annotations: annotationsOut,
    text
  }
}

/* ————————————————— 完成：提炼洞见与行动项 ————————————————— */

const HarvestSchema = z.object({
  insights: z
    .array(
      z.object({
        statement: z.string().max(300).describe('一句话的洞见：用户自己得出的认识，用他的意思表述'),
        confidence: z.enum(['hypothesis', 'believed', 'verified']).describe('hypothesis 猜想；believed 相信但未验证；verified 有证据'),
        evidence: z.string().max(300).describe('依据：复盘中的原话')
      })
    )
    .max(5),
  revisions: z
    .array(
      z.object({
        ref: z.string().max(10).describe('被修正的已有洞见编号，如 i2'),
        statement: z.string().max(300),
        confidence: z.enum(['hypothesis', 'believed', 'verified']),
        reason: z.string().max(300).describe('为什么修正：复盘中的依据')
      })
    )
    .max(5),
  actions: z
    .array(z.object({ title: z.string().max(200).describe('具体、可完成的行动'), dueInDays: z.number().int().min(0).max(90).nullable() }))
    .max(6)
})

export async function harvestReflection(id: string): Promise<ReflectionHarvest> {
  const r = getReflection(id)
  if (!r) throw new Error('Reflection not found')
  const zh = zhUI()
  const s = getSettings()
  if (!s.ai.chat.providerId || !s.ai.chat.model) throw new Error(zh ? '还没有设置 AI 模型' : 'No AI model configured')
  const body = reflectionText(id)
  if (!body.replace(/【[^】]*】|（还没写）|\(empty\)/g, '').trim()) throw new Error(zh ? '复盘还是空的' : 'The reflection is empty')
  const existing = listInsights().filter((i) => i.status === 'active').slice(0, 40)
  const refs = new Map(existing.map((x, i) => [`i${i + 1}`, x]))
  const out = await structured({
    providerId: s.ai.chat.providerId,
    model: s.ai.chat.model,
    system: zh
      ? `你帮用户整理一次复盘。只提炼用户**自己写出的**认识与打算，不要替他总结出他没写的结论。
- insights：用户得出的洞见（对学习、方法、领域的认识），一句话，保留他的意思。没有就留空。
- revisions：如果复盘中的认识修正、推翻或加强了某条已有洞见，用它的编号给出新表述、新的把握程度和原因。
- actions：用户写下的具体打算，dueInDays 为几天后到期（没说就按下周 7 天）。
- 用简体中文。`
      : `You help the user wrap up a reflection. Extract only insights and plans the user actually wrote — do not invent conclusions.
- insights: the user's own realisations, one sentence each.
- revisions: when the reflection revises, refutes or strengthens an existing insight, give its ref, the new wording, confidence and reason.
- actions: concrete plans; dueInDays (default 7).`,
    prompt: [
      existing.length
        ? `${zh ? '已有洞见' : 'Existing insights'}：\n${existing.map((x, i) => `i${i + 1} [${x.confidence}] ${x.statement}`).join('\n')}`
        : '',
      `${zh ? '复盘' : 'Reflection'}（${r.title}）：\n${clip(body, 8000)}`
    ]
      .filter(Boolean)
      .join('\n\n'),
    schema: HarvestSchema
  })
  return {
    insights: out.insights,
    revisions: out.revisions
      .map((v) => {
        const target = refs.get(v.ref)
        return target ? { insightId: target.id, current: target.statement, statement: v.statement, confidence: v.confidence, reason: v.reason } : null
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    actions: out.actions
  }
}

/** 保存用户确认的洞见、修正与行动项，复盘标记为完成 */
export function commitReflection(id: string, input: HarvestCommit): Reflection {
  const r = getReflection(id)
  if (!r) throw new Error('Reflection not found')
  const db = getDb()
  const now = Date.now()
  db.transaction((tx) => {
    for (const it of input.insights) {
      const insightId = newId()
      tx.insert(insights)
        .values({ id: insightId, statement: it.statement, confidence: it.confidence, reviewId: id, createdAt: now, updatedAt: now, updatedBy: deviceId() })
        .run()
      tx.insert(insightVersions)
        .values({ id: newId(), insightId, version: 1, statement: it.statement, confidence: it.confidence, reason: it.evidence ?? null, createdAt: now })
        .run()
      if (r.noteId)
        tx.insert(links)
          .values({ id: newId(), fromType: 'insight', fromId: insightId, toType: 'note', toId: r.noteId, origin: 'manual', createdAt: now, updatedAt: now, updatedBy: deviceId() })
          .run()
    }
    for (const v of input.revisions) reviseInsight(tx, v.insightId, { statement: v.statement, confidence: v.confidence, reason: v.reason }, now)
    for (const a of input.actions)
      tx.insert(actions).values({ id: newId(), title: a.title, dueAt: a.dueAt, reviewId: id, createdAt: now, updatedAt: now, updatedBy: deviceId() }).run()
    tx.update(reviews).set({ status: 'done', completedAt: now, updatedAt: now }).where(eq(reviews.id, id)).run()
  })
  emit('reflection:changed', {})
  return getReflection(id)!
}

/* ————————————————— 洞见 ————————————————— */

type InsightRow = typeof insights.$inferSelect
const toInsight = (r: InsightRow): Insight => ({
  id: r.id,
  statement: r.statement,
  confidence: r.confidence,
  status: r.status,
  version: r.version,
  reviewId: r.reviewId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
})

export function listInsights(): Insight[] {
  return getDb().select().from(insights).where(isNull(insights.deletedAt)).orderBy(desc(insights.updatedAt)).all().map(toInsight)
}

export function insightHistory(id: string): InsightVersion[] {
  return getDb()
    .select()
    .from(insightVersions)
    .where(eq(insightVersions.insightId, id))
    .orderBy(asc(insightVersions.version))
    .all()
    .map((v) => ({ version: v.version, statement: v.statement, confidence: v.confidence as InsightConfidence, reason: v.reason, createdAt: v.createdAt }))
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/** 修正一条洞见：版本加一，留下原因（认知成长轨迹） */
function reviseInsight(
  tx: Tx,
  id: string,
  patch: { statement?: string; confidence?: InsightConfidence; status?: 'active' | 'refuted'; reason?: string },
  now = Date.now()
): void {
  const cur = tx.select().from(insights).where(eq(insights.id, id)).get()
  if (!cur) return
  const statement = patch.statement?.trim() || cur.statement
  const confidence = patch.confidence ?? cur.confidence
  const status = patch.status ?? (cur.status === 'refuted' ? 'refuted' : 'active')
  const version = cur.version + 1
  tx.update(insights).set({ statement, confidence, status, version, updatedAt: now, updatedBy: deviceId() }).where(eq(insights.id, id)).run()
  tx.insert(insightVersions)
    .values({
      id: newId(),
      insightId: id,
      version,
      statement: status === 'refuted' && !patch.statement ? cur.statement : statement,
      confidence,
      reason: patch.reason ?? null,
      createdAt: now
    })
    .run()
}

export function updateInsight(id: string, patch: { statement?: string; confidence?: InsightConfidence; status?: 'active' | 'refuted'; reason?: string }): Insight {
  const db = getDb()
  db.transaction((tx) => reviseInsight(tx, id, patch))
  emit('reflection:changed', {})
  return toInsight(db.select().from(insights).where(eq(insights.id, id)).get()!)
}

export function removeInsight(id: string): void {
  getDb().update(insights).set({ deletedAt: Date.now(), updatedAt: Date.now() }).where(eq(insights.id, id)).run()
  emit('reflection:changed', {})
}

/* ————————————————— 行动项 ————————————————— */

type ActionRow = typeof actions.$inferSelect
function toAction(r: ActionRow): ActionItem {
  return { id: r.id, title: r.title, status: r.status, dueAt: r.dueAt, doneAt: r.doneAt, reviewId: r.reviewId, goalId: r.goalId, createdAt: r.createdAt }
}

export function listActions(status?: ActionItem['status']): ActionItem[] {
  return getDb()
    .select()
    .from(actions)
    .where(and(isNull(actions.deletedAt), status ? eq(actions.status, status) : undefined))
    .orderBy(sql`${actions.dueAt} IS NULL`, asc(actions.dueAt), desc(actions.createdAt))
    .limit(200)
    .all()
    .map(toAction)
}

export function createAction(title: string, dueAt: number | null, goalId: string | null = null): ActionItem {
  const now = Date.now()
  const id = newId()
  getDb().insert(actions).values({ id, title, dueAt, goalId, createdAt: now, updatedAt: now, updatedBy: deviceId() }).run()
  emit('reflection:changed', {})
  return toAction(getDb().select().from(actions).where(eq(actions.id, id)).get()!)
}

export function updateAction(id: string, patch: { title?: string; status?: ActionItem['status']; dueAt?: number | null }): ActionItem {
  const now = Date.now()
  getDb()
    .update(actions)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      ...(patch.status ? { status: patch.status, doneAt: patch.status === 'done' ? now : null } : {}),
      updatedAt: now,
      updatedBy: deviceId()
    })
    .where(eq(actions.id, id))
    .run()
  emit('reflection:changed', {})
  return toAction(getDb().select().from(actions).where(eq(actions.id, id)).get()!)
}

export function removeAction(id: string): void {
  getDb().update(actions).set({ deletedAt: Date.now(), updatedAt: Date.now() }).where(eq(actions.id, id)).run()
  emit('reflection:changed', {})
}
