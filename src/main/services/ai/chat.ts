import { streamText, type ModelMessage } from 'ai'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb } from '../../db'
import { conversations, messages, notes, sources } from '../../db/schema'
import { newId } from '../../lib/ids'
import { deviceId } from '../device'
import { emit } from '../../events'
import { getSettings } from '../settings'
import { estimateCost, type Effort, type Usage } from '@shared/ai'
import type { ChatScope, ChatSend } from '@shared/schemas'
import type { ChatMessage, Citation, Conversation, SearchHit } from '@shared/types'
import { buildModel } from './model'
import { retrieve } from './retrieve'

// AI 对话：检索知识库 → 组织带时间与状态的上下文 → 流式生成 → 记录引用与用量。

type MsgRow = typeof messages.$inferSelect
type ConvRow = typeof conversations.$inferSelect

const HISTORY_TURNS = 10
const running = new Map<string, AbortController>()

const toConversation = (r: ConvRow): Conversation => ({
  id: r.id,
  title: r.title,
  scope: JSON.parse(r.scope) as ChatScope,
  pinned: r.pinned,
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
  createdAt: r.createdAt
})

export function listConversations(): Conversation[] {
  return getDb()
    .select()
    .from(conversations)
    .where(isNull(conversations.deletedAt))
    .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
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
const STATUS_ZH: Record<string, string> = { active: '有效', outdated: '已过时', disputed: '存疑' }
const ORIGIN_ZH: Record<string, string> = { user: '用户亲手写', ai: 'AI 生成未审阅', ai_reviewed: 'AI 生成经用户审阅' }

function describeHit(h: SearchHit, n: number): string {
  if (h.parentType === 'note') {
    const meta = [
      `学习于 ${fmtDate(h.learnedAt)}`,
      `本段修改于 ${fmtDate(h.updatedAt)}`,
      `状态：${STATUS_ZH[h.status ?? 'active']}`,
      ORIGIN_ZH[h.origin ?? 'user']
    ]
    return `[${n}] 笔记《${h.title || '无标题'}》（${meta.join(' · ')}）\n${h.text}`
  }
  const meta = [`获取于 ${fmtDate(h.updatedAt)}`, ...(h.locator ? [`位置：${h.locator}`] : [])]
  return `[${n}] 资料《${h.title}》（${meta.join(' · ')}）\n${h.text}`
}

function systemPrompt(lang: string, hits: SearchHit[], ctx: string | null): string {
  const zh = lang.startsWith('zh')
  const rules = zh
    ? `你是「积微」的学习助手，帮助用户理解、整理和内化自己学到的知识。
规则：
1. 优先依据下面的「知识库片段」回答。用到某个片段时，在相应句子末尾标注编号，如 [1] 或 [2][3]。只能使用列出的编号。
2. 片段带有时间与状态：同一主题的新旧说法不一致时，以较新的为准，并明确指出“你在某日记录为……，某日更新为……”。“已过时”的内容只作为历史参考；“存疑”的内容需提醒用户核实。
3. 用户亲手写的内容最能代表用户自己的理解；AI 生成未审阅的内容可信度较低。
4. 知识库中没有的内容可以用你的通用知识补充，但这部分不要标注编号；若整段都来自通用知识，请在段首注明“（以下来自通用知识）”。
5. 知识库中找不到相关内容时，直接说明，并给出你的通用回答。
6. 使用简洁的中文 Markdown。`
    : `You are Jiwei's learning assistant, helping the user understand, organize and internalize what they have learned.
Rules:
1. Prefer the "knowledge base excerpts" below. When you use one, cite it at the end of the sentence like [1] or [2][3]. Only use the listed numbers.
2. Excerpts carry dates and status. When old and new statements on the same topic conflict, prefer the newer one and say so explicitly ("you noted X on …, updated to Y on …"). Treat "outdated" as historical only; ask the user to verify "disputed" items.
3. Content the user wrote themselves best reflects their own understanding; unreviewed AI-generated content is less reliable.
4. You may add general knowledge not in the knowledge base, but do not cite it; if a whole paragraph comes from general knowledge, start it with "(From general knowledge)".
5. If nothing relevant is in the knowledge base, say so and give your general answer.
6. Use concise Markdown.`
  const kb = hits.length
    ? `${zh ? '知识库片段' : 'Knowledge base excerpts'}：\n\n${hits.map((h, i) => describeHit(h, i + 1)).join('\n\n')}`
    : zh
      ? '知识库片段：（本次没有检索到相关内容）'
      : 'Knowledge base excerpts: (none found)'
  return [rules, ctx, kb, `${zh ? '今天是' : 'Today is'} ${fmtDate(Date.now())}。`].filter(Boolean).join('\n\n')
}

/** 用户正在看的内容（工作区上下文）→ 提示词片段 */
function contextPrompt(input: ChatSend, zh: boolean): string | null {
  const c = input.context
  if (!c) return null
  const db = getDb()
  const parts: string[] = []
  if (c.noteId) {
    const n = db.select({ title: notes.title, aiExcluded: notes.aiExcluded }).from(notes).where(eq(notes.id, c.noteId)).get()
    if (n && !n.aiExcluded) {
      parts.push(`${zh ? '用户正在编辑笔记' : 'Current note'}《${n.title || (zh ? '无标题' : 'Untitled')}》`)
      if (c.noteSelection) parts.push(`${zh ? '笔记中选中的文字' : 'Selected in note'}：\n${c.noteSelection}`)
    }
  }
  if (c.sourceId) {
    const s = db.select({ title: sources.title, aiExcluded: sources.aiExcluded }).from(sources).where(eq(sources.id, c.sourceId)).get()
    if (s && !s.aiExcluded) {
      parts.push(`${zh ? '用户正在阅读资料' : 'Current source'}《${s.title}》${c.sourceLocator ? `（${c.sourceLocator}）` : ''}`)
      if (c.sourceSelection) parts.push(`${zh ? '资料中选中的文字' : 'Selected in source'}：\n${c.sourceSelection}`)
    }
  }
  return parts.length ? `${zh ? '当前工作区' : 'Workspace'}：\n${parts.join('\n')}` : null
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
        title: input.text.replace(/\s+/g, ' ').slice(0, 40),
        scope: JSON.stringify(input.scope),
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
  let lastFlush = 0
  const flush = (force = false): void => {
    if (!force && Date.now() - lastFlush < 400) return
    lastFlush = Date.now()
    db.update(messages)
      .set({ content, reasoning: reasoning || null, updatedAt: Date.now() })
      .where(eq(messages.id, messageId))
      .run()
  }
  const finish = (status: ChatMessage['status'], error: string | null, usage: ChatMessage['usage']): void => {
    db.update(messages)
      .set({
        content,
        reasoning: reasoning || null,
        citations: JSON.stringify(citations),
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

  try {
    const lang = getSettings().language
    const zh = lang.startsWith('zh')
    // 检索：用问题本身 + 工作区选中文字
    const query = [input.text, input.context?.sourceSelection, input.context?.noteSelection].filter(Boolean).join('\n').slice(0, 2000)
    const hits = await retrieve(query, input.scope, 8)
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

    const built = buildModel({ providerId: input.providerId, model: input.model, effort: input.effort })
    const result = streamText({
      model: built.model,
      system: systemPrompt(lang, hits, contextPrompt(input, zh)),
      messages: msgs,
      providerOptions: built.providerOptions as never,
      maxOutputTokens: built.maxOutputTokens,
      abortSignal: ctrl.signal
    })
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        content += part.text
        emit('chat:delta', { messageId, conversationId, text: part.text })
      } else if (part.type === 'reasoning-delta') {
        reasoning += part.text
        emit('chat:delta', { messageId, conversationId, reasoning: part.text })
      } else if (part.type === 'error') {
        throw part.error
      }
      flush()
    }
    // 只保留回答中实际引用到的片段（保持原编号）
    const used = new Set([...content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
    citations = hits
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
    const u = await result.usage
    const usage: Usage = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
      cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0
    }
    finish('done', null, { ...usage, cost: estimateCost(input.model, usage), durationMs: Date.now() - t0 })
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
