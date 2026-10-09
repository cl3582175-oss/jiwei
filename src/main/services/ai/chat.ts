import { stepCountIs, streamText, type ModelMessage } from 'ai'
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb } from '../../db'
import { conversations, messages } from '../../db/schema'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { emit } from '../../events'
import { getSettings } from '../settings'
import { estimateCost, type Effort, type ModelTier, type Usage } from '@shared/ai'
import type { ChatScope, ChatSend } from '@shared/schemas'
import type { Anchor } from '@shared/context'
import type { AgentStep, ChatMessage, Citation, Conversation } from '@shared/types'
import { buildModel } from './model'
import { capsFor } from './providers'
import { retrieve } from './retrieve'
import { resolveContext } from './context'
import { buildTools, numberHits, stepLabel, type AgentSession } from './tools'
import { loadSkill, skillCatalog } from './skills'
import { userCard } from '../memory'
import { learnerNote } from '../learner'
import { noteExplainRequest, scheduleExtract } from '../memoryLearn'
import { ensureReference, feynmanSystem, parseMeta, toInfo as feynmanInfo, type FeynmanMeta } from '../feynman'
import { coachSystem, coachTurn, ensureCoachMaterial, type CoachMeta } from '../reflectionCoach'

// AI 对话：检索知识库 → 组织带时间与状态的上下文 → 流式生成 → 记录引用与用量。

type MsgRow = typeof messages.$inferSelect
type ConvRow = typeof conversations.$inferSelect

const HISTORY_TURNS = 10
/** 一次回答最多的工具调用轮数 */
const MAX_STEPS = 10
const running = new Map<string, AbortController>()
/**
 * 用户卡片按对话固定：对话开始时取一次，之后不变（后台整理记忆不会打断前缀缓存）。
 * 下一次对话再取最新的。
 */
const cards = new Map<string, string | null>()
function cardFor(conversationId: string, zh: boolean): string | null {
  if (!cards.has(conversationId)) {
    if (cards.size > 200) cards.delete(cards.keys().next().value!)
    cards.set(conversationId, userCard(zh))
  }
  return cards.get(conversationId)!
}

const toConversation = (r: ConvRow): Conversation => ({
  id: r.id,
  title: r.title,
  scope: JSON.parse(r.scope) as ChatScope,
  pinned: r.pinned,
  incognito: r.incognito,
  kind: r.kind,
  anchor: r.anchor ? (JSON.parse(r.anchor) as Anchor) : null,
  feynman: r.kind === 'feynman' ? feynmanInfo(parseMeta(r.meta)) : null,
  reflectionId: r.kind === 'reflection' && r.meta ? ((JSON.parse(r.meta) as { reflectionId?: string }).reflectionId ?? null) : null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
})

const toMessage = (r: MsgRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversationId,
  role: r.role,
  content: r.content,
  reasoning: r.reasoning,
  citations: r.citations ? (JSON.parse(r.citations) as Citation[]) : [],
  providerId: r.providerId,
  model: r.model,
  effort: r.effort as Effort | null,
  usage: r.usage ? (JSON.parse(r.usage) as ChatMessage['usage']) : null,
  status: r.status,
  error: r.error,
  skill: r.skill,
  steps: r.steps ? (JSON.parse(r.steps) as AgentStep[]) : [],
  createdAt: r.createdAt
})

/** 对话页列表：就地提问（inline）挂在原文旁边，费曼练习（feynman）在复习与学习经历中，都不在其中 */
export function listConversations(): Conversation[] {
  return getDb()
    .select()
    .from(conversations)
    .where(
      and(isNull(conversations.deletedAt), ne(conversations.kind, 'inline'), ne(conversations.kind, 'feynman'), ne(conversations.kind, 'reflection'))
    )
    .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
    .all()
    .map(toConversation)
}

export function getConversation(id: string): Conversation | null {
  const r = getDb().select().from(conversations).where(eq(conversations.id, id)).get()
  return r && !r.deletedAt ? toConversation(r) : null
}

/** 某份资料 / 笔记上的就地提问（用于原文边缘标记） */
export function listThreads(parentId: string): Conversation[] {
  return getDb()
    .select()
    .from(conversations)
    .where(and(isNull(conversations.deletedAt), eq(conversations.kind, 'inline'), eq(conversations.anchorParentId, parentId)))
    .orderBy(asc(conversations.createdAt))
    .all()
    .map(toConversation)
}

export function listMessages(conversationId: string): ChatMessage[] {
  return getDb()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map(toMessage)
}

export function updateConversation(id: string, patch: { title?: string; scope?: ChatScope; pinned?: boolean }): void {
  getDb()
    .update(conversations)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.scope ? { scope: JSON.stringify(patch.scope) } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      updatedAt: Date.now(),
      updatedBy: deviceId()
    })
    .where(eq(conversations.id, id))
    .run()
}

export function deleteConversation(id: string): void {
  const db = getDb()
  running.forEach((ctrl, mid) => {
    const m = db.select({ c: messages.conversationId }).from(messages).where(eq(messages.id, mid)).get()
    if (m?.c === id) ctrl.abort()
  })
  db.transaction((tx) => {
    tx.delete(messages).where(eq(messages.conversationId, id)).run()
    tx.delete(conversations).where(eq(conversations.id, id)).run()
  })
}

const fmtDate = (ts: number | null): string => (ts ? new Date(ts).toISOString().slice(0, 10) : '未知')

/**
 * 系统提示：只放稳定内容（规则 + 技能目录 + 用户卡片 + 日期），每轮字节相同，便于命中前缀缓存。
 * 每轮变化的上下文、检索片段放在最后一条用户消息里。
 */
function systemPrompt(zh: boolean, tier: ModelTier, incognito: boolean, conversationId: string): string {
  const rules = zh
    ? `你是「积微」的学习助手，帮助用户理解、整理和内化自己学到的知识。用户的知识库 = 用户写的笔记 + 用户上传的原始资料。
规则：
1. 优先依据「知识库片段」回答。用到某个片段时，在句末标注编号，如 [1] 或 [2][3]。只能使用已出现的编号（包括工具返回的编号）。
2. 片段带有时间与状态：新旧说法不一致时以较新的为准，并明确指出变化；“已过时”只作历史参考；“存疑”需提醒核实。用户亲手写的内容最能代表用户自己的理解。
3. 知识库中没有的内容可以用通用知识补充，但不要标注编号；整段来自通用知识时，在段首注明“（以下来自通用知识）”。
4. 「上下文」是用户此刻指着的内容（选中的文字、所在段落、视频时间段等）。用户说“这个 / 这里 / 刚才 / 这段”时，指的就是它。
5. 需要时使用工具：片段不够就 knowledge_search；修改笔记只能通过 note_* 工具提交提案（用户确认后才生效），不要声称已经改好了。
6. 任务与某个技能相符时，先 skills_load 再照做。
7. {{MEMORY_RULE}}
8. 使用简洁的 Markdown。始终用简体中文回答（工具结果或资料是其他语言时也一样），除非用户明确用其他语言提问。`
    : `You are Jiwei's learning assistant. The knowledge base = the user's notes + the source materials they uploaded.
Rules:
1. Prefer the "knowledge base excerpts". Cite used excerpts at sentence end like [1] or [2][3]; only use numbers that appeared (including tool results).
2. Excerpts carry dates and status: prefer newer statements and point out changes; "outdated" is historical; ask to verify "disputed". User-written content best reflects their own understanding.
3. General knowledge may supplement but is not cited; prefix whole general-knowledge paragraphs with "(From general knowledge)".
4. "Context" is what the user is pointing at now (selection, paragraph, media time range). "this / here / just now" refers to it.
5. Use tools when needed: knowledge_search for more excerpts; change notes only via note_* proposal tools (applied after the user confirms) — never claim edits are done.
6. When a task matches a skill, call skills_load first and follow it.
7. {{MEMORY_RULE}}
8. Use concise Markdown. Always answer in English (even if tools or sources are in another language) unless the user writes in another language.`
  // 无痕对话没有记忆工具：规则也要一致，否则模型会去调用不存在的工具
  const memoryRule = incognito
    ? zh
      ? '这是无痕对话：不要记录任何关于用户的信息；用户要求“记住”时，告诉他无痕对话中不会记住，可以在普通对话中再说一次。'
      : 'This is an incognito chat: do not record anything about the user; if asked to remember, explain that incognito chats are not remembered.'
    : zh
      ? '用户明确要求记住，或表达了稳定的偏好、目标、背景时，用 memory_remember 记下；不要记一次性的请求。'
      : 'Use memory_remember when the user explicitly asks to remember, or states stable preferences, goals or background; not for one-off requests.'
  const card = incognito ? null : cardFor(conversationId, zh)
  return [
    rules.replace('{{MEMORY_RULE}}', memoryRule),
    skillCatalog(tier, zh),
    card
      ? `${zh ? '用户卡片（关于这位用户，回答时自然地参考，不要复述）' : 'About the user (use naturally, do not recite)'}：\n${card}`
      : null,
    `${zh ? '今天是' : 'Today is'} ${fmtDate(Date.now())}。`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 本轮用户消息：上下文 + 检索片段 + 预加载的技能 + 问题 */
function turnMessage(zh: boolean, text: string, ctx: string, kb: string | null, skill: string | null): string {
  const parts: string[] = []
  if (ctx) parts.push(`<${zh ? '上下文' : 'context'}>\n${ctx}\n</${zh ? '上下文' : 'context'}>`)
  if (kb !== null)
    parts.push(
      `<${zh ? '知识库片段' : 'excerpts'}>\n${kb || (zh ? '（没有检索到相关内容）' : '(none found)')}\n</${zh ? '知识库片段' : 'excerpts'}>`
    )
  if (skill) parts.push(`<${zh ? '技能' : 'skill'}>\n${skill}\n</${zh ? '技能' : 'skill'}>`)
  parts.push(parts.length ? `${zh ? '用户' : 'User'}：${text}` : text)
  return parts.join('\n\n')
}

export interface SendResult {
  conversation: Conversation
  userMessage: ChatMessage
  assistantMessageId: string
}

export function send(input: ChatSend): SendResult {
  const db = getDb()
  const now = Date.now()
  let convId = input.conversationId
  if (!convId) {
    convId = newId()
    db.insert(conversations)
      .values({
        id: convId,
        title: input.feynman ? input.feynman.concept.slice(0, 40) : input.text.replace(/\s+/g, ' ').slice(0, 40),
        scope: JSON.stringify(input.scope),
        incognito: !!input.incognito,
        kind: input.feynman ? 'feynman' : input.reflectionId ? 'reflection' : (input.kind ?? 'chat'),
        anchor: input.anchor ? JSON.stringify(input.anchor) : null,
        anchorParentId: input.anchor?.parentId ?? input.feynman?.noteId ?? null,
        meta: input.reflectionId
          ? JSON.stringify({ reflectionId: input.reflectionId } satisfies CoachMeta)
          : input.feynman
          ? JSON.stringify({
              concept: input.feynman.concept.trim(),
              noteId: input.feynman.noteId ?? null,
              cardId: input.feynman.cardId ?? null,
              report: null
            } satisfies FeynmanMeta)
          : null,
        createdAt: now,
        updatedAt: now,
        updatedBy: deviceId()
      })
      .run()
  } else {
    db.update(conversations)
      .set({ scope: JSON.stringify(input.scope), updatedAt: now })
      .where(eq(conversations.id, convId))
      .run()
  }
  const userMsg: MsgRow = {
    id: newId(),
    conversationId: convId,
    role: 'user',
    content: input.text,
    reasoning: null,
    citations: null,
    context: input.context ? JSON.stringify(input.context) : null,
    skill: input.skill ?? null,
    steps: null,
    providerId: null,
    model: null,
    effort: null,
    usage: null,
    status: 'done',
    error: null,
    createdAt: now,
    updatedAt: now
  }
  db.insert(messages).values(userMsg).run()
  const assistantId = newId()
  db.insert(messages)
    .values({
      id: assistantId,
      conversationId: convId,
      role: 'assistant',
      content: '',
      providerId: input.providerId,
      model: input.model,
      effort: input.effort,
      status: 'streaming',
      createdAt: now + 1,
      updatedAt: now + 1
    })
    .run()
  void generate(convId, assistantId, input)
  // 选区“解释这个词”：直接记一次学习信号（学习者模型）
  const conv = db.select({ incognito: conversations.incognito }).from(conversations).where(eq(conversations.id, convId)).get()
  if (input.skill === 'explain-concept' && !conv?.incognito) {
    try {
      noteExplainRequest(convId, input.anchor?.quote ?? input.context?.targets[0]?.quote)
    } catch (e) {
      log.warn('[chat] record concept failed', e)
    }
  }
  return {
    conversation: toConversation(db.select().from(conversations).where(eq(conversations.id, convId)).get()!),
    userMessage: toMessage(userMsg),
    assistantMessageId: assistantId
  }
}

async function generate(conversationId: string, messageId: string, input: ChatSend): Promise<void> {
  const db = getDb()
  const ctrl = new AbortController()
  running.set(messageId, ctrl)
  const t0 = Date.now()
  let content = ''
  let reasoning = ''
  let citations: Citation[] = []
  const steps: AgentStep[] = []
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()!
  const zh = getSettings().language.startsWith('zh')
  const session: AgentSession = {
    zh,
    model: input.model,
    tier: capsFor(input.providerId, input.model).tier,
    scope: input.scope,
    incognito: conv.incognito,
    conversationId,
    messageId,
    hits: [],
    skills: input.skill ? [input.skill] : []
  }
  let lastFlush = 0
  const flush = (force = false): void => {
    if (!force && Date.now() - lastFlush < 400) return
    lastFlush = Date.now()
    db.update(messages)
      .set({ content, reasoning: reasoning || null, steps: steps.length ? JSON.stringify(steps) : null, updatedAt: Date.now() })
      .where(eq(messages.id, messageId))
      .run()
  }
  const finish = (status: ChatMessage['status'], error: string | null, usage: ChatMessage['usage']): void => {
    db.update(messages)
      .set({
        content,
        reasoning: reasoning || null,
        citations: JSON.stringify(citations),
        skill: session.skills[0] ?? null,
        steps: steps.length ? JSON.stringify(steps) : null,
        usage: usage ? JSON.stringify(usage) : null,
        status,
        error,
        updatedAt: Date.now()
      })
      .where(eq(messages.id, messageId))
      .run()
    db.update(conversations).set({ updatedAt: Date.now() }).where(eq(conversations.id, conversationId)).run()
    running.delete(messageId)
    emit('chat:done', { message: toMessage(db.select().from(messages).where(eq(messages.id, messageId)).get()!) })
  }
  const pushStep = (step: AgentStep): void => {
    const i = steps.findIndex((x) => x.id === step.id)
    if (i >= 0) steps[i] = step
    else steps.push(step)
    emit('chat:step', { messageId, conversationId, step })
    flush(true)
  }

  // 费曼练习：AI 扮演学生，只追问；不检索、不用工具，参考资料固定在系统提示中
  let feynman = conv.kind === 'feynman' ? parseMeta(conv.meta) : null
  // 复盘追问：素材包固定在系统提示中，当前复盘正文随本轮消息发送
  let coach = conv.kind === 'reflection' && conv.meta ? (JSON.parse(conv.meta) as CoachMeta) : null
  try {
    if (feynman) feynman = await ensureReference(conversationId, feynman)
    if (coach) coach = ensureCoachMaterial(conversationId, coach)
    const ctx = feynman || coach ? { text: '', query: '' } : resolveContext(input.context, zh)
    // 检索：问题本身 + 用户指着的文字
    const query = [input.text, ctx.query].filter(Boolean).join('\n').slice(0, 2000)
    const hits = feynman || coach || input.scope.type === 'none' ? [] : await retrieve(query, input.scope, 8)
    const kb = feynman || coach || input.scope.type === 'none' ? null : numberHits(session, hits)
    const skillBody = input.skill && !feynman && !coach ? loadSkill(input.skill, zh) : null

    // 历史只带原话（不重复带旧的上下文与片段，省 token）
    const history = db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_TURNS * 2 + 2)
      .all()
      .reverse()
      .filter((m) => m.id !== messageId && (m.role === 'user' || m.status === 'done') && m.content)
    const msgs: ModelMessage[] = history.map((m) => ({ role: m.role, content: m.content }))
    // 最后一条（本轮）用户消息附上上下文、片段与技能
    const last = msgs.at(-1)
    if (last?.role === 'user' && coach) last.content = coachTurn(coach, input.text, zh)
    else if (last?.role === 'user' && !feynman) {
      const vision = capsFor(input.providerId, input.model).vision
      const imageNote =
        input.images?.length && !vision
          ? zh
            ? '（用户框选了一块图像区域，但当前模型看不到图像；请依据区域中的文字和上下文回答，并在开头提示用户：换用能看图的模型可以得到更准确的解释。）'
            : '(The user selected an image region, but this model cannot see images; answer from the region text and context, and mention that a vision model would do better.)'
          : ''
      const learner = session.incognito ? null : learnerNote(query, zh)
      const text = turnMessage(zh, input.text, [ctx.text, learner, imageNote].filter(Boolean).join('\n\n'), kb, skillBody)
      if (input.images?.length && vision)
        msgs[msgs.length - 1] = {
          role: 'user',
          content: [{ type: 'text', text }, ...input.images.map((image) => ({ type: 'image' as const, image }))]
        }
      else last.content = text
    }

    const built = buildModel({ providerId: input.providerId, model: input.model, effort: input.effort })
    const run = (withTools: boolean) =>
      streamText({
        model: built.model,
        system: feynman
          ? feynmanSystem(feynman, zh)
          : coach
            ? coachSystem(coach, zh)
            : systemPrompt(zh, session.tier, session.incognito, conversationId),
        messages: msgs,
        ...(withTools && !feynman && !coach ? { tools: buildTools(session), stopWhen: stepCountIs(MAX_STEPS) } : {}),
        providerOptions: built.providerOptions as never,
        maxOutputTokens: built.maxOutputTokens,
        abortSignal: ctrl.signal
      })
    let result = run(true)
    let retried = false
    const usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }
    for (;;) {
      try {
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            content += part.text
            emit('chat:delta', { messageId, conversationId, text: part.text })
          } else if (part.type === 'reasoning-delta') {
            reasoning += part.text
            emit('chat:delta', { messageId, conversationId, reasoning: part.text })
          } else if (part.type === 'tool-call') {
            pushStep({ id: part.toolCallId, tool: part.toolName, status: 'running', ...stepLabel(part.toolName, part.input, zh) })
          } else if (part.type === 'tool-result') {
            const prev = steps.find((x) => x.id === part.toolCallId)
            if (prev) pushStep({ ...prev, status: 'done' })
          } else if (part.type === 'tool-error') {
            const prev = steps.find((x) => x.id === part.toolCallId)
            const err = part.error instanceof Error ? part.error.message : String(part.error)
            if (prev) pushStep({ ...prev, status: 'error', detail: err.slice(0, 300) })
          } else if (part.type === 'finish-step') {
            // 多步之间补一个段落分隔，避免两步的文字粘在一起
            if (content && !content.endsWith('\n')) content += '\n\n'
          } else if (part.type === 'error') {
            throw part.error
          }
          flush()
        }
        break
      } catch (e) {
        // 少数模型 / 接口不支持工具调用：去掉工具重试一次
        const msg = e instanceof Error ? e.message : String(e)
        if (!retried && !content && !ctrl.signal.aborted && /tool|function/i.test(msg)) {
          log.warn('[chat] tools unsupported, retrying without tools:', msg)
          retried = true
          result = run(false)
          continue
        }
        throw e
      }
    }
    content = content.trimEnd()
    // 只保留回答中实际引用到的片段（保持原编号）
    const used = new Set([...content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
    citations = session.hits
      .map((h, i) => ({
        n: i + 1,
        parentType: h.parentType,
        parentId: h.parentId,
        ownerId: h.ownerId,
        title: h.title,
        snippet: h.text.slice(0, 280),
        locator: h.locator,
        learnedAt: h.learnedAt,
        updatedAt: h.updatedAt,
        status: h.status,
        origin: h.origin
      }))
      .filter((c) => used.has(c.n))
    // 服务商实际使用的模型（可能与请求的名称不同，例如旧名被路由到新模型）
    const served = (await result.response).modelId
    if (served && served !== input.model) log.info('[chat] requested', input.model, 'served by', served)
    const u = await result.totalUsage
    usage.inputTokens = u.inputTokens ?? 0
    usage.outputTokens = u.outputTokens ?? 0
    usage.reasoningTokens = u.outputTokenDetails?.reasoningTokens ?? 0
    usage.cachedInputTokens = u.inputTokenDetails?.cacheReadTokens ?? 0
    finish('done', null, { ...usage, cost: estimateCost(input.model, usage), durationMs: Date.now() - t0 })
    if (!session.incognito) scheduleExtract(conversationId)
  } catch (e) {
    if (ctrl.signal.aborted) return finish('stopped', null, null)
    const msg = e instanceof Error ? e.message : String(e)
    log.error('[chat] generate failed', msg)
    finish('error', msg, null)
  }
}

export function stop(messageId: string): void {
  running.get(messageId)?.abort()
}

/** 退出前中止所有生成 */
export function stopAll(): void {
  running.forEach((c) => c.abort())
}
