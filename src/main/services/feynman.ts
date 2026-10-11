import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { conversations, messages, notes } from '../db/schema'
import { nodeText } from '../lib/derive'
import { isConceptLike, normConcept } from '../lib/learner'
import { markdownToNodes } from '../lib/markdown'
import { emit } from '../events'
import type { FeynmanHome, FeynmanInfo, FeynmanReport } from '@shared/types'
import { getSettings } from './settings'
import { loadDoc, stateToContent } from './docs'
import { createNote, getNote } from './notes'
import { createProposal } from './proposals'
import { conceptsIn, describeConcept, recordConcept } from './learner'
import { getMemorySettings } from './memory'
import { retrieve } from './ai/retrieve'
import { listCards } from './review'
import { loadSkill } from './ai/skills'
import { structured } from './ai/structured'

// 费曼练习（v0.4.1）：用户把一个概念讲给“完全不懂的学生”听，AI 按技能 feynman 追问，找出漏洞；
// 讲完后诊断：讲清楚了什么、哪里没讲清楚、哪里说错了，并给出可以补进笔记的线索问题（进入复习）。
// 设计见 docs/design/v0.4-learning-loop.md §3。

/** 存在 conversations.meta 中：参考资料在第一轮时生成并固定（系统提示整段稳定，便于命中缓存） */
export type FeynmanMeta = FeynmanInfo & { reference?: string }

const zhUI = (): boolean => getSettings().language.startsWith('zh')
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

export function parseMeta(raw: string | null): FeynmanMeta | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as FeynmanMeta
  } catch {
    return null
  }
}

export function toInfo(m: FeynmanMeta | null): FeynmanInfo | null {
  if (!m) return null
  return { concept: m.concept, noteId: m.noteId ?? null, cardId: m.cardId ?? null, report: m.report ?? null }
}

function saveMeta(conversationId: string, meta: FeynmanMeta): void {
  getDb()
    .update(conversations)
    .set({ meta: JSON.stringify(meta), updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run()
}

/** 关联笔记中与概念相关的行（找不到就取整篇笔记的开头） */
function noteReference(noteId: string, concept: string): string {
  const note = getDb().select({ title: notes.title, aiExcluded: notes.aiExcluded, deletedAt: notes.deletedAt }).from(notes).where(eq(notes.id, noteId)).get()
  if (!note || note.deletedAt || note.aiExcluded) return ''
  const { doc } = stateToContent(loadDoc(noteId))
  const rows = (doc.content ?? []).map((n) => nodeText(n).trim()).filter(Boolean)
  const key = normConcept(concept)
  const hit = rows.filter((r) => key.length >= 2 && normConcept(r).includes(key))
  const text = (hit.length ? hit : rows).join('\n\n')
  return text ? `《${note.title || '无标题'}》\n${clip(text, 3000)}` : ''
}

/** 第一轮时生成参考资料：关联笔记 + 知识库检索 */
export async function ensureReference(conversationId: string, meta: FeynmanMeta): Promise<FeynmanMeta> {
  if (meta.reference !== undefined) return meta
  const parts: string[] = []
  if (meta.noteId) {
    const n = noteReference(meta.noteId, meta.concept)
    if (n) parts.push(n)
  }
  const hits = (await retrieve(meta.concept, { type: 'all' }, 6).catch(() => [])).filter((h) => h.parentId !== meta.noteId)
  let budget = 2500
  for (const h of hits) {
    if (budget <= 0) break
    const t = `《${h.title}》${clip(h.text, 600)}`
    parts.push(t)
    budget -= t.length
  }
  const next = { ...meta, reference: parts.join('\n\n---\n\n') }
  saveMeta(conversationId, next)
  return next
}

/** 费曼练习的系统提示：技能正文 + 概念 + 学习情况 + 参考资料（整段在一次练习中不变） */
export function feynmanSystem(meta: FeynmanMeta, zh: boolean): string {
  const known = conceptsIn(meta.concept, 1)[0]
  return [
    loadSkill('feynman', zh),
    `${zh ? '本次要讲的概念' : 'Concept to explain'}：${meta.concept}`,
    known ? `${zh ? '用户之前的学习情况（不要透露）' : "User's history with it (do not reveal)"}：${describeConcept(known, zh)}` : '',
    meta.reference
      ? `<${zh ? '参考资料' : 'reference'}>\n${meta.reference}\n</${zh ? '参考资料' : 'reference'}>`
      : zh
        ? '（没有找到参考资料，凭你对这个概念的了解判断。）'
        : '(No reference material; rely on your own knowledge.)',
    zh ? '始终用简体中文，像聊天一样说话。' : 'Always answer in English, conversationally.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/* ————————————————— 讲完后的诊断 ————————————————— */

const ReportSchema = z.object({
  verdict: z.string().max(400).describe('一两句总体评价，先肯定讲清楚的部分'),
  level: z.enum(['weak', 'learning', 'solid']).describe('weak 关键处讲不清或有错；learning 大体对但有漏洞；solid 讲得清楚完整'),
  clear: z.array(z.string().max(200)).max(8).describe('讲清楚了的要点'),
  gaps: z
    .array(z.object({ point: z.string().max(200).describe('没讲清楚 / 漏掉的要点'), hint: z.string().max(300).describe('可以怎样补') }))
    .max(6),
  misconceptions: z.array(z.string().max(300)).max(5).describe('说错的地方，以及正确的说法'),
  cues: z
    .array(z.object({ question: z.string().max(120), answer: z.string().max(600) }))
    .max(5)
    .describe('针对漏洞与错误的复习问题：问题用于康奈尔线索栏，答案简明准确')
})

export async function finishFeynman(conversationId: string): Promise<FeynmanReport> {
  const db = getDb()
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
  const meta = parseMeta(conv?.meta ?? null)
  if (!conv || !meta) throw new Error('Not a Feynman session')
  const zh = zhUI()
  const msgs = db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt).all()
  const said = msgs.filter((m) => m.role === 'user' && m.content.trim())
  if (!said.length) throw new Error(zh ? '还没有开始讲' : 'Nothing explained yet')
  const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.providerId && m.model)
  const s = getSettings()
  const providerId = last?.providerId ?? s.ai.chat.providerId
  const model = last?.model ?? s.ai.chat.model
  if (!providerId || !model) throw new Error(zh ? '还没有设置 AI 模型' : 'No AI model configured')
  const transcript = msgs
    .filter((m) => m.content.trim())
    .map((m) => `${m.role === 'user' ? (zh ? '讲解者' : 'Explainer') : zh ? '学生' : 'Student'}：${clip(m.content, 2000)}`)
    .join('\n')
  // 诊断用对话所用的模型（质量优先），关闭思考
  const out = await structured({ purpose: 'feynman',
    providerId,
    model,
    system: zh
      ? `你是一位严谨又温和的老师。下面是用户用费曼技巧讲解「${meta.concept}」的记录（一位学生在追问）。请对照参考资料与你的知识，诊断用户自己的讲解：
- 只评价用户（讲解者）说的话，不要把学生的复述算作用户讲清楚了。
- clear：用户确实用自己的话讲清楚的要点。gaps：重要但没讲到、或讲得含糊的要点，hint 说明怎样补。misconceptions：说错的地方并给出正确说法。
- cues：针对 gaps 和 misconceptions 出 2～4 个复习问题，问题短、答案准确（可依据参考资料），用于康奈尔笔记线索栏。
- 用简体中文。`
      : `You are a rigorous but kind teacher. Below is the user explaining "${meta.concept}" using the Feynman technique, with a student asking questions. Diagnose the user's own explanation against the reference and your knowledge:
- Judge only what the explainer said.
- clear: points truly explained; gaps: important points missing or vague, with a hint; misconceptions: errors with corrections.
- cues: 2–4 review questions targeting gaps and errors, short questions and accurate answers.`,
    prompt: [
      meta.reference ? `${zh ? '参考资料' : 'Reference'}：\n${meta.reference}` : '',
      `${zh ? '讲解记录' : 'Transcript'}：\n${transcript}`
    ]
      .filter(Boolean)
      .join('\n\n'),
    schema: ReportSchema
  })
  const report: FeynmanReport = { ...out, finishedAt: Date.now() }
  saveMeta(conversationId, { ...meta, report })
  // 学习者模型：讲得清楚 → 理解；关键处讲不清 → 没弄懂（从复习卡片进入时“概念”是一个问题，不记）
  if (getMemorySettings().autoLearn && report.level !== 'learning' && isConceptLike(meta.concept))
    recordConcept(meta.concept, report.level === 'solid' ? 'understood' : 'confused', { conversationId, note: report.gaps[0]?.point })
  emit('memory:changed', {})
  return report
}

/**
 * 把选中的复习问题补进笔记（康奈尔的线索 + 笔记，之后自动成为复习卡片）。
 * 用户主动的操作：以“自动应用”的提案写入（保留 AI 来源标记，可撤销）。
 */
export function addFeynmanCues(conversationId: string, indices: number[]): { noteId: string; created: boolean } {
  const conv = getDb().select().from(conversations).where(eq(conversations.id, conversationId)).get()
  const meta = parseMeta(conv?.meta ?? null)
  const cues = meta?.report?.cues.filter((_, i) => indices.includes(i)) ?? []
  if (!meta || !cues.length) throw new Error('Nothing to add')
  const zh = zhUI()
  let noteId = meta.noteId
  let created = false
  if (!noteId || !getNote(noteId)) {
    noteId = createNote({ title: zh ? `费曼练习：${meta.concept}` : `Feynman: ${meta.concept}` }).id
    created = true
  }
  createProposal({
    noteId,
    title: zh ? `费曼练习：补上「${meta.concept}」的漏洞` : `Feynman: fill gaps in "${meta.concept}"`,
    ops: cues.map((c) => ({ op: 'insert_row' as const, afterRowId: null, cue: markdownToNodes(c.question), body: markdownToNodes(c.answer) })),
    skill: 'feynman',
    auto: true
  })
  return { noteId, created }
}

/* ——— 首页（v0.7.6）：从导航进入时显示历史练习与推荐的概念 ——— */

export function feynmanHome(): FeynmanHome {
  const db = getDb()
  const sessions = db
    .select({ id: conversations.id, meta: conversations.meta, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(and(eq(conversations.kind, 'feynman'), isNull(conversations.deletedAt)))
    .orderBy(desc(conversations.updatedAt))
    .limit(30)
    .all()
    .flatMap((c) => {
      const m = parseMeta(c.meta)
      return m ? [{ id: c.id, concept: m.concept, noteId: m.noteId, level: m.report?.level ?? null, updatedAt: c.updatedAt }] : []
    })
  const practiced = new Set(sessions.map((s) => normConcept(s.concept)))
  const suggestions: FeynmanHome['suggestions'] = []
  const push = (s: FeynmanHome['suggestions'][number]): void => {
    const key = normConcept(s.concept)
    if (!s.concept.trim() || practiced.has(key) || suggestions.some((x) => normConcept(x.concept) === key)) return
    suggestions.push({ ...s, concept: clip(s.concept.replace(/\s+/g, ' ').trim(), 40) })
  }
  // 常忘的卡片：遗忘次数多、正在重学
  for (const c of listCards('weak').filter((c) => c.kind === 'cornell').slice(0, 8)) {
    if (suggestions.length >= 4) break
    push({ concept: c.question, noteId: c.noteId, cardId: c.id, reason: 'weak' })
  }
  // 最近学的笔记
  for (const n of db
    .select({ id: notes.id, title: notes.title })
    .from(notes)
    .where(and(isNull(notes.deletedAt), eq(notes.aiExcluded, false), sql`${notes.title} <> ''`))
    .orderBy(desc(notes.updatedAt))
    .limit(6)
    .all()) {
    if (suggestions.length >= 7) break
    push({ concept: n.title, noteId: n.id, cardId: null, reason: 'recent' })
  }
  return { sessions, suggestions }
}
