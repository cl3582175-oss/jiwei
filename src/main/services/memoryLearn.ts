import { z } from 'zod'
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb } from '../db'
import { conversations, messages, notes } from '../db/schema'
import { profileDb } from '../db/profile'
import { newId } from '../lib/ids'
import { emit } from '../events'
import { classifyEdit, isConceptLike, looksSensitive, normConcept, similarity } from '../lib/learner'
import { nodeText } from '../lib/derive'
import { embedText } from '@shared/embeds'
import type { ContextPacket } from '@shared/context'
import type { DocNode, Memory, Proposal } from '@shared/types'
import { getSettings } from './settings'
import { listBlocks } from './docs'
import { getMemorySettings, getMemory, getMeta, getUserProfile, markUsed, saveMemory, setMeta, skillPreferences, fadeMemories } from './memory'
import { recordConcept } from './learner'
import { quickModel, structured } from './ai/structured'
import { listSkills } from './ai/skills'

// 记忆 v2：让积微在后台“越用越懂你”。设计见 docs/design/v0.3-agent.md §5。
//   ① 对话安静下来后整理：新增 / 更新 / 作废记忆（参考 Mem0 的 ADD / UPDATE / DELETE / NONE 流程），
//      记录概念信号（学习者模型），写一条学习经历；用快速模型、关闭思考，一次调用完成。
//   ② 技能偏好：AI 提案被拒绝、被改写、被删掉时留下样本；同一技能攒够样本后归纳出稳定偏好。
//   ③ 淡出：长期没用到的 AI 记忆归档。
// 这些都不进入“后台任务”列表：它们是安静的、可失败的，失败只记日志，下次再试。

/** 对话最后一条消息之后多久开始整理（毫秒）；测试可用环境变量缩短 */
const EXTRACT_DELAY = Number(process.env.JIWEI_MEMORY_DELAY_MS ?? 120_000)
/** 一次整理最多看的消息数 */
const MAX_MESSAGES = 16
/** 启动后补整理：最近这么多天内有新消息、还没整理过的对话 */
const CATCH_UP_DAYS = 7
const MAINTAIN_EVERY = 30 * 60_000
/** AI 写入的内容稳定这么久后再判断用户有没有改它 */
const SETTLE_MS = 10 * 60_000
/** 同一技能攒够这么多条负面样本（拒绝 / 改写 / 删除）才归纳 */
const INDUCE_MIN = 3

const timers = new Map<string, NodeJS.Timeout>()
let chain: Promise<unknown> = Promise.resolve()
let maintainTimer: NodeJS.Timeout | null = null
let stopped = false

/** 串行执行（避免并发占用模型配额，也避免同一对话被整理两次） */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

const zhUI = (): boolean => getSettings().language.startsWith('zh')
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

/* ————————————————— ① 对话后整理 ————————————————— */

/** 每次回答完成后调用：对话安静 EXTRACT_DELAY 后整理 */
export function scheduleExtract(conversationId: string): void {
  if (stopped) return
  clearTimeout(timers.get(conversationId))
  timers.set(
    conversationId,
    setTimeout(() => {
      timers.delete(conversationId)
      void learnFromConversation(conversationId).catch((e) => log.warn('[memory] extract failed', e instanceof Error ? e.message : e))
    }, EXTRACT_DELAY)
  )
}

/** 选区“解释”这个词：不需要模型，立即记一次“请求解释” */
export function noteExplainRequest(conversationId: string, quote: string | undefined): void {
  if (!quote || !isConceptLike(quote) || !getMemorySettings().autoLearn) return
  recordConcept(quote, 'asked', { conversationId })
}

const ExtractSchema = z.object({
  memories: z
    .array(
      z.object({
        op: z.enum(['add', 'update', 'invalidate']),
        ref: z.string().max(10).optional().describe('update / invalidate：已有记忆的编号，如 m3'),
        kind: z.enum(['preference', 'fact', 'glossary']).optional(),
        content: z.string().max(300).optional().describe('add / update：完整的记忆内容'),
        sensitive: z.boolean().optional(),
        quote: z.string().max(200).optional().describe('依据：用户的原话')
      })
    )
    .max(8),
  reinforced: z.array(z.string().max(10)).max(20).optional().describe('本次对话中得到印证或用到的已有记忆编号'),
  concepts: z
    .array(
      z.object({
        name: z.string().max(40),
        signal: z.enum(['asked', 'confused', 'understood']),
        note: z.string().max(200).optional().describe('卡在哪里 / 怎样表现出理解')
      })
    )
    .max(10),
  episode: z.string().max(400).nullable().describe('学习经历：学了什么、卡在哪、得出什么结论；不是学习就为 null')
})
type Extract = z.infer<typeof ExtractSchema>

const RULES_ZH = `你负责整理「积微」学习助手对用户的长期记忆。阅读一段新的对话，输出要新增 / 更新 / 作废的记忆、概念信号与学习经历。
规则：
1. 只记关于“用户这个人”的长期信息：稳定的偏好（回答方式、学习方式）、关于他的事实（职业、正在学什么、目标、已有基础）、他的个人术语或简称。
2. 不记：一次性的请求、对话里讨论的知识本身、助手说的话、已经在用户卡片或已有记忆中的内容、用户说“不要记”的内容、个人档案“请避免”中列出的内容。对某个具体概念懂不懂，只写进 concepts，不写成记忆。
3. 已有记忆被新信息修正：update（写完整的新内容）；明显不再成立：invalidate；与对话一致或在对话中被用到：把编号放进 reinforced。只能引用给出的编号。
4. 健康、财务、人际关系、宗教、政治相关的标记 sensitive。
5. content 用简短陈述，不带主语，如“喜欢先看例子再看定义”“正在备考 CPA，目标 2027 年通过”。
6. concepts：用户请教过、没弄懂、或表现出已经理解的具体概念（名称用资料中的说法，2～12 个字）。asked：只是请求解释；confused：表示没懂、看不明白、搞不清，或理解有误——即使同时在请求解释，也用 confused；understood：用自己的话正确复述或正确运用。助手顺带提到的概念不算。
7. episode：如果这是一次学习，用一两句话写“学了什么、卡在哪、得出什么结论”（不带主语）；已有学习经历时合并更新；闲聊或操作性对话为 null。
8. 没有值得记的就返回空数组。宁缺毋滥。`

const RULES_EN = `You maintain the long-term memory of the "Jiwei" learning assistant about its user. Read a new conversation and output memories to add / update / invalidate, concept signals, and a learning episode.
Rules:
1. Only lasting facts about the user as a person: stable preferences (answer and learning style), facts (job, what they study, goals, background), personal terms.
2. Do not record: one-off requests, the knowledge discussed, what the assistant said, things already in the card or memories, things the user asked not to remember, or anything listed under "Please avoid". Whether they understand a specific concept goes only into concepts, never into memories.
3. Corrected memory → update (write the full new content); no longer true → invalidate; confirmed or used → put its ref in reinforced. Only use the given refs.
4. Mark health, finance, relationships, religion and politics as sensitive.
5. Write content as short statements without a subject, e.g. "Prefers examples before definitions".
6. concepts: specific concepts the user asked about, was confused by, or showed understanding of (2–6 words). asked = just asking for an explanation; confused = says they don't get it or misunderstands (use confused even if they also ask for an explanation); understood = restates or applies it correctly. Not concepts merely mentioned by the assistant.
7. episode: if this was learning, one or two sentences on what was studied, where they got stuck, what they concluded; merge with the existing episode; null for small talk.
8. Return empty arrays when nothing is worth keeping.`

/** 消息里用户指着的内容（选区原文），帮助识别概念名 */
function pointedText(ctx: string | null): string {
  if (!ctx) return ''
  try {
    const p = JSON.parse(ctx) as ContextPacket
    return p.targets
      .map((t) => t.quote)
      .filter(Boolean)
      .map((q) => clip(q!, 200))
      .join(' / ')
  } catch {
    return ''
  }
}

/** 整理一个对话中尚未整理的新消息。返回新增 / 更新的记忆数。 */
export function learnFromConversation(conversationId: string): Promise<{ added: number; concepts: number; episode: boolean }> {
  return serial(() => extract(conversationId))
}

async function extract(conversationId: string): Promise<{ added: number; concepts: number; episode: boolean }> {
  const none = { added: 0, concepts: 0, episode: false }
  if (stopped || !getMemorySettings().autoLearn) return none
  const db = getDb()
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
  if (!conv || conv.deletedAt || conv.incognito) return none
  const pdb = profileDb()
  const since =
    (pdb.prepare('SELECT last_message_at FROM extract_state WHERE conversation_id = ?').get(conversationId) as { last_message_at: number } | undefined)
      ?.last_message_at ?? 0
  const rows = db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), gt(messages.createdAt, since)))
    .orderBy(asc(messages.createdAt))
    .all()
  // 还在生成中：稍后再来
  if (rows.some((m) => m.status === 'streaming')) {
    scheduleExtract(conversationId)
    return none
  }
  const msgs = rows.filter((m) => m.content && (m.role === 'user' || m.status === 'done')).slice(-MAX_MESSAGES)
  const done = (): void => {
    const last = rows.at(-1)?.createdAt
    if (last)
      pdb
        .prepare(
          'INSERT INTO extract_state (conversation_id, last_message_at) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET last_message_at = excluded.last_message_at'
        )
        .run(conversationId, last)
  }
  if (!msgs.some((m) => m.role === 'user')) {
    done()
    return none
  }
  const assistant = [...rows].reverse().find((m) => m.role === 'assistant' && m.providerId && m.model)
  const s = getSettings()
  const providerId = assistant?.providerId ?? s.ai.chat.providerId
  const model = assistant?.model ?? s.ai.chat.model
  if (!providerId || !model) return none

  const zh = zhUI()
  const transcript = msgs
    .map((m) => {
      if (m.role === 'assistant') return `${zh ? '助手' : 'Assistant'}：${clip(m.content, 600)}`
      const pointed = pointedText(m.context)
      return `${zh ? '用户' : 'User'}：${clip(m.content, 1200)}${pointed ? `\n  （${zh ? '指着' : 'pointing at'}：${pointed}）` : ''}`
    })
    .join('\n')

  // 候选的已有记忆：常用的 + 与本次对话相关的，用短编号代替 ID（省 token，也防止编造 ID）
  const userText = msgs
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ')
  const candidates = candidateMemories(userText)
  const refs = new Map(candidates.map((m, i) => [`m${i + 1}`, m]))
  const episodeKey = `conv:${conversationId}`
  const prevEpisode = pdb.prepare("SELECT content FROM memories WHERE kind = 'episode' AND key = ?").get(episodeKey) as
    | { content: string }
    | undefined
  const profile = getUserProfile()

  const prompt = [
    profile.avoid ? `${zh ? '个人档案“请避免”' : 'Please avoid'}：${profile.avoid}` : '',
    `${zh ? '已有记忆' : 'Existing memories'}：\n${candidates.length ? candidates.map((m, i) => `m${i + 1} [${m.kind}${m.origin === 'user' ? (zh ? '，用户写的' : ', user-written') : ''}] ${m.content}`).join('\n') : zh ? '（无）' : '(none)'}`,
    prevEpisode ? `${zh ? '这次对话已有的学习经历' : 'Existing episode for this conversation'}：${prevEpisode.content}` : '',
    `${zh ? '对话标题' : 'Title'}：${conv.title}`,
    `${zh ? '新的对话内容' : 'New messages'}：\n${transcript}`
  ]
    .filter(Boolean)
    .join('\n\n')

  const out: Extract = await structured({ purpose: 'memory',
    providerId,
    model: quickModel(providerId, model),
    system: zh ? RULES_ZH : RULES_EN,
    prompt,
    schema: ExtractSchema
  })
  if (stopped) return none
  const result = apply(out, refs, { conversationId, episodeKey, lastMessageId: msgs.at(-1)?.id })
  done()
  log.info('[memory] learned from conversation', conversationId, result)
  return result
}

function candidateMemories(text: string): Memory[] {
  const db = profileDb()
  type R = { id: string }
  const top = db
    .prepare(
      `SELECT id FROM memories WHERE status IN ('active', 'pending') AND kind IN ('preference', 'fact', 'glossary')
       ORDER BY pinned DESC, use_count DESC, updated_at DESC LIMIT 40`
    )
    .all() as R[]
  const ids = new Set(top.map((r) => r.id))
  // 与本次对话相关的（trigram 全文检索；不计入“使用”）
  const terms = [...new Set(text.match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 30).map((t) => `"${t.slice(0, 20).replace(/"/g, '')}"`)
  if (terms.length) {
    try {
      const related = db
        .prepare(
          `SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND m.status = 'active' AND m.kind IN ('preference', 'fact', 'glossary') ORDER BY rank LIMIT 20`
        )
        .all(terms.join(' OR ')) as R[]
      related.forEach((r) => ids.add(r.id))
    } catch {
      /* 检索语法问题：只用常用记忆 */
    }
  }
  return [...ids].map((id) => getMemory(id)!).filter(Boolean)
}

function apply(
  out: Extract,
  refs: Map<string, Memory>,
  ev: { conversationId: string; episodeKey: string; lastMessageId?: string }
): { added: number; concepts: number; episode: boolean } {
  const db = profileDb()
  const learned: Memory[] = []
  // 对某个概念懂不懂由学习者模型记录；提到本次概念的“记忆”是重复的，丢弃
  const conceptNorms = out.concepts.map((c) => normConcept(c.name)).filter((n) => n.length >= 2)
  for (const m of out.memories) {
    if (m.op === 'add') {
      const content = m.content?.trim()
      if (!content) continue
      if (conceptNorms.some((n) => normConcept(content).includes(n))) continue
      const sensitive = !!m.sensitive || looksSensitive(content)
      const before = Date.now()
      const saved = saveMemory(
        { kind: m.kind ?? 'preference', content, sensitive },
        'ai',
        { conversationId: ev.conversationId, messageId: ev.lastMessageId, quote: m.quote },
        { silent: true }
      )
      // 已存在的相同记忆只会刷新时间，不算新记住
      if (saved.createdAt >= before) learned.push(saved)
      continue
    }
    const target = m.ref ? refs.get(m.ref) : undefined
    // 用户亲手写的、钉住的记忆，AI 不改也不作废，只能印证
    if (!target || target.origin !== 'ai' || target.pinned) continue
    if (m.op === 'update' && m.content?.trim() && m.content.trim() !== target.content) {
      db.prepare('UPDATE memories SET content = ?, evidence = ?, updated_at = ? WHERE id = ?').run(
        m.content.trim(),
        JSON.stringify({ conversationId: ev.conversationId, quote: m.quote, previous: target.content }),
        Date.now(),
        target.id
      )
      learned.push(getMemory(target.id)!)
    } else if (m.op === 'invalidate') {
      db.prepare("UPDATE memories SET status = 'archived', invalid_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), target.id)
    }
  }
  markUsed((out.reinforced ?? []).map((r) => refs.get(r)?.id).filter((x): x is string => !!x))

  let concepts = 0
  for (const c of out.concepts) if (recordConcept(c.name, c.signal, { conversationId: ev.conversationId, note: c.note }, { silent: true })) concepts++

  const episode = out.episode?.trim()
  if (episode) saveMemory({ kind: 'episode', key: ev.episodeKey, content: episode }, 'ai', { conversationId: ev.conversationId }, { silent: true })

  // 敏感内容逐条询问；普通内容合并成一条提示（可撤销）
  const pending = learned.filter((m) => m.status === 'pending')
  const active = learned.filter((m) => m.status !== 'pending')
  pending.forEach((m) => emit('memory:changed', { added: m }))
  emit('memory:changed', active.length ? { learned: active } : {})
  return { added: learned.length, concepts, episode: !!episode }
}

/** 启动时补整理：最近有新消息、但还没整理过的对话（例如上次退出前没来得及） */
function catchUp(): void {
  if (!getMemorySettings().autoLearn) return
  const since = Date.now() - CATCH_UP_DAYS * 86_400_000
  const convs = getDb()
    .select({ id: conversations.id, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(and(isNull(conversations.deletedAt), eq(conversations.incognito, false), gt(conversations.updatedAt, since)))
    .orderBy(desc(conversations.updatedAt))
    .limit(20)
    .all()
  const state = profileDb().prepare('SELECT last_message_at FROM extract_state WHERE conversation_id = ?')
  for (const c of convs) {
    const last = getDb()
      .select({ at: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, c.id))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()?.at
    const seen = (state.get(c.id) as { last_message_at: number } | undefined)?.last_message_at ?? 0
    if (last && last > seen && Date.now() - last > EXTRACT_DELAY) void learnFromConversation(c.id).catch(() => {})
  }
}

/* ————————————————— ② 技能偏好 ————————————————— */

function opText(op: Proposal['ops'][number], embeds: Proposal['embeds']): string {
  const nodes: DocNode[] =
    op.op === 'insert_row'
      ? [...(op.cue as DocNode[]), ...(op.body as DocNode[])]
      : op.op === 'delete_block'
        ? []
        : (op.nodes as DocNode[])
  const text = (n: DocNode): string => {
    if (n.type === 'embed') {
      const id = (n.attrs as { id?: string } | undefined)?.id
      const e = id ? embeds[id] : undefined
      return e ? embedText(e.kind, e.data) : ''
    }
    return n.content?.some((c) => c.type === 'embed') ? n.content.map(text).join('\n') : nodeText(n)
  }
  return nodes.map(text).filter(Boolean).join('\n').trim()
}

/** 提案中的一处修改被接受或拒绝：留下样本（接受的过一段时间再看有没有被改） */
export function recordProposalDecision(p: Proposal, opIndex: number, decision: 'accepted' | 'rejected', blockIds?: string[]): void {
  if (!p.skill || p.auto || !getMemorySettings().learnSkills) return
  const op = p.ops[opIndex]
  if (!op || op.op === 'delete_block') return
  const before = clip(opText(op, p.embeds), 2000)
  if (!before) return
  profileDb()
    .prepare('INSERT INTO skill_feedback (id, skill, kind, note_id, block_ids, before, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      newId(),
      p.skill,
      decision === 'rejected' ? 'rejected' : 'pending',
      p.noteId,
      blockIds?.length ? JSON.stringify(blockIds) : null,
      before,
      Date.now()
    )
}

type Feedback = {
  id: string
  skill: string
  kind: string
  note_id: string | null
  block_ids: string | null
  before: string
  after: string | null
  created_at: number
}

/** 被接受的 AI 内容稳定后，看用户有没有改它、删它 */
export function reviewFeedback(now = Date.now(), force = false): number {
  const pdb = profileDb()
  const rows = pdb.prepare("SELECT * FROM skill_feedback WHERE kind = 'pending'").all() as Feedback[]
  let n = 0
  for (const f of rows) {
    if (!force && now - f.created_at < SETTLE_MS) continue
    const note = f.note_id ? getDb().select({ updatedAt: notes.updatedAt, deletedAt: notes.deletedAt }).from(notes).where(eq(notes.id, f.note_id)).get() : null
    // 笔记不在当前知识库 / 已删除：无法判断，丢弃样本
    if (!note || note.deletedAt) {
      pdb.prepare("UPDATE skill_feedback SET kind = 'lost', checked_at = ?, consumed_at = ? WHERE id = ?").run(now, now, f.id)
      continue
    }
    // 用户可能还在改：等笔记安静 5 分钟（最多等 3 天）
    if (!force && now - note.updatedAt < 5 * 60_000 && now - f.created_at < 3 * 86_400_000) continue
    const blocks = listBlocks(f.note_id!)
    let r: { kind: 'kept' | 'edited' | 'deleted'; after?: string }
    if (f.block_ids) {
      // 编辑器报告了写入的块：按 ID 找回（整行写入时取该行中的各块），准确判断有没有改
      const ids = new Set(JSON.parse(f.block_ids) as string[])
      const mine = blocks.filter((b) => b.section !== 'row' && (ids.has(b.id) || (b.rowId !== null && ids.has(b.rowId))))
      const now = mine
        .map((b) => b.text)
        .filter(Boolean)
        .join('\n')
        .trim()
      r = !now ? { kind: 'deleted' } : similarity(f.before, now) >= 0.97 ? { kind: 'kept' } : { kind: 'edited', after: now }
    } else {
      // 旧数据 / 无 ID：按文字相似度在笔记中找最像的块
      const byRow = new Map<string, string[]>()
      for (const b of blocks) if (b.rowId) byRow.set(b.rowId, [...(byRow.get(b.rowId) ?? []), b.text])
      r = classifyEdit(f.before, [...blocks.map((b) => b.text), ...[...byRow.values()].map((t) => t.join('\n'))])
    }
    pdb
      .prepare('UPDATE skill_feedback SET kind = ?, after = ?, checked_at = ?, consumed_at = ? WHERE id = ?')
      .run(r.kind, r.after ? clip(r.after, 2000) : null, now, r.kind === 'kept' ? now : null, f.id)
    n++
  }
  return n
}

const PrefSchema = z.object({
  preferences: z
    .array(z.object({ content: z.string().max(200).describe('一条可执行的输出偏好') }))
    .max(2)
    .describe('证据不足时为空数组')
})

/** 某个技能攒够负面样本后，归纳出稳定的输出偏好（作为技能偏好记忆，下次使用该技能时附上） */
export function induceSkillPreferences(): Promise<Memory[]> {
  return serial(async () => {
    if (!getMemorySettings().learnSkills) return []
    const pdb = profileDb()
    const ready = pdb
      .prepare(
        `SELECT skill, COUNT(*) AS n FROM skill_feedback
         WHERE consumed_at IS NULL AND kind IN ('rejected', 'edited', 'deleted') GROUP BY skill HAVING n >= ?`
      )
      .all(INDUCE_MIN) as { skill: string; n: number }[]
    const s = getSettings()
    const providerId = s.ai.chat.providerId
    const model = s.ai.chat.model
    if (!ready.length || !providerId || !model) return []
    const zh = zhUI()
    const learned: Memory[] = []
    for (const { skill } of ready) {
      const samples = pdb
        .prepare(
          `SELECT * FROM skill_feedback WHERE skill = ? AND consumed_at IS NULL AND kind IN ('rejected', 'edited', 'deleted')
           ORDER BY created_at DESC LIMIT 8`
        )
        .all(skill) as Feedback[]
      const kept = (pdb.prepare("SELECT COUNT(*) AS n FROM skill_feedback WHERE skill = ? AND kind = 'kept'").get(skill) as { n: number }).n
      const existing = skillPreferences(skill)
      const label = (k: string): string =>
        zh
          ? ({ rejected: '用户拒绝了这份输出', edited: '用户接受后改写了它', deleted: '用户接受后又删掉了它' }[k] ?? k)
          : ({ rejected: 'The user rejected this output', edited: 'The user accepted, then rewrote it', deleted: 'The user accepted, then deleted it' }[k] ?? k)
      const prompt = [
        `${zh ? '技能' : 'Skill'}：${listSkills().find((x) => x.name === skill)?.title || skill}（${skill}）`,
        existing.length ? `${zh ? '已有偏好（不要重复）' : 'Existing preferences (do not repeat)'}：\n${existing.map((e) => `- ${e}`).join('\n')}` : '',
        `${zh ? `另有 ${kept} 次输出被原样保留。` : `${kept} outputs were kept unchanged.`}`,
        samples
          .map(
            (f, i) =>
              `#${i + 1} ${label(f.kind)}\n${zh ? 'AI 输出' : 'AI output'}：${clip(f.before, 700)}${f.after ? `\n${zh ? '用户改成' : 'User changed it to'}：${clip(f.after, 700)}` : ''}`
          )
          .join('\n\n')
      ]
        .filter(Boolean)
        .join('\n\n')
      try {
        const out = await structured({ purpose: 'memory',
          providerId,
          model: quickModel(providerId, model),
          system: zh
            ? '你在帮学习助手了解用户对某个技能输出的稳定偏好。下面的记录都是用户不满意的输出：被拒绝、被删掉，或被改写（同时给出改后的样子）。对比 AI 输出与用户想要的样子，找出反复出现、可执行的格式或风格要求（如“表格不超过 4 列”“思维导图每个节点不超过 12 个字”“总结只写一句话”）。偏好描述用户想要什么，不要描述被否定的输出本身的特点。只是修正事实错误、或者证据只有一两次且不一致时，返回空数组。每条偏好一句话，不带主语，写成以后生成时要遵守的要求。'
            : "You help a learning assistant learn the user's stable preferences for one skill's output. Every record below is output the user was unhappy with: rejected, deleted, or rewritten (with the rewrite shown). Compare the AI output with what the user wanted and find repeated, actionable format or style requirements (e.g. \"tables have at most 4 columns\", \"summaries are one sentence\"). Describe what the user wants, never the traits of the rejected output. Return an empty array if edits only fix facts or evidence is thin. One sentence each, no subject, phrased as a rule for future output.",
          prompt,
          schema: PrefSchema
        })
        for (const p of out.preferences) {
          const before = Date.now()
          const m = saveMemory({ kind: 'skill', skill, content: p.content.trim() }, 'ai', { quote: zh ? `来自 ${samples.length} 次修改与拒绝` : `From ${samples.length} edits and rejections` }, { silent: true })
          if (m.createdAt >= before) learned.push(m)
        }
        const now = Date.now()
        const stmt = pdb.prepare('UPDATE skill_feedback SET consumed_at = ? WHERE id = ?')
        samples.forEach((f) => stmt.run(now, f.id))
      } catch (e) {
        log.warn('[memory] skill induction failed', skill, e instanceof Error ? e.message : e)
      }
    }
    if (learned.length) emit('memory:changed', { learned })
    return learned
  })
}

/* ————————————————— 维护 ————————————————— */

/** 定期维护：检查 AI 内容的去向、归纳技能偏好、每天一次淡出 */
export async function maintain(opts: { force?: boolean } = {}): Promise<{ reviewed: number; skills: number; faded: number }> {
  const reviewed = reviewFeedback(Date.now(), opts.force)
  const skills = (await induceSkillPreferences()).length
  let faded = 0
  const last = Number(getMeta('lastFadeAt') ?? 0)
  if (opts.force || Date.now() - last > 86_400_000) {
    faded = fadeMemories()
    setMeta('lastFadeAt', String(Date.now()))
  }
  return { reviewed, skills, faded }
}

export function startMemoryLearning(): void {
  stopped = false
  setTimeout(() => {
    if (stopped) return
    try {
      catchUp()
    } catch (e) {
      log.warn('[memory] catch-up failed', e)
    }
    void maintain().catch((e) => log.warn('[memory] maintain failed', e))
  }, 30_000)
  maintainTimer = setInterval(() => void maintain().catch((e) => log.warn('[memory] maintain failed', e)), MAINTAIN_EVERY)
}

export function stopMemoryLearning(): void {
  stopped = true
  timers.forEach((t) => clearTimeout(t))
  timers.clear()
  if (maintainTimer) clearInterval(maintainTimer)
  maintainTimer = null
}
