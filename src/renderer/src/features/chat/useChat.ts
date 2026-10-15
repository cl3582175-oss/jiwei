import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Effort } from '@shared/ai'
import type { ChatMessage, Conversation } from '@shared/types'
import type { ChatSendRequest } from '@shared/schemas'
import { useProviders, useSettings } from '@/lib/queries'
import { api } from '@/lib/utils'
import type { ModelChoice } from '../ai/ModelPicker'

// 对话的共用逻辑：对话页、工作区 AI 面板、就地答复卡片都用它。

/** 一个对话的消息列表：加载 + 订阅流式增量、步骤与完成事件 */
export function useChatThread(conversationId: string | null) {
  const qc = useQueryClient()
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const { data: loaded } = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => api.chat.messages(conversationId!),
    enabled: !!conversationId
  })
  useEffect(() => setMsgs(conversationId ? (loaded ?? []) : []), [loaded, conversationId])

  useEffect(() => {
    const offDelta = window.jiweiEvents.on('chat:delta', (d) => {
      setMsgs((list) =>
        list.map((m) =>
          m.id === d.messageId
            ? { ...m, content: m.content + (d.text ?? ''), reasoning: d.reasoning ? (m.reasoning ?? '') + d.reasoning : m.reasoning }
            : m
        )
      )
    })
    const offStep = window.jiweiEvents.on('chat:step', ({ messageId, step }) => {
      setMsgs((list) =>
        list.map((m) => {
          if (m.id !== messageId) return m
          const i = m.steps.findIndex((x) => x.id === step.id)
          const steps = i >= 0 ? m.steps.map((x, j) => (j === i ? step : x)) : [...m.steps, step]
          // 新一步开始时，之前流出的文字与新文字之间留出段落
          return { ...m, steps, content: i < 0 && m.content && !m.content.endsWith('\n') ? m.content + '\n\n' : m.content }
        })
      )
    })
    const offReadiness = window.jiweiEvents.on('chat:readiness', ({ messageId, items }) => {
      setMsgs((list) => list.map((m) => (m.id === messageId ? { ...m, readiness: items } : m)))
      void qc.invalidateQueries({ queryKey: ['messages'] })
    })
    const offDone = window.jiweiEvents.on('chat:done', ({ message }) => {
      setMsgs((list) => list.map((m) => (m.id === message.id ? message : m)))
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      void qc.invalidateQueries({ queryKey: ['messages', message.conversationId] })
    })
    return () => {
      offDelta()
      offStep()
      offDone()
      offReadiness()
    }
  }, [qc])

  const streaming = msgs.find((m) => m.status === 'streaming') ?? null
  return { msgs, setMsgs, streaming }
}

/** 模型与思考强度：默认取设置中的值 */
export function useModelChoice() {
  const { data: settings } = useSettings()
  const { data: providers = [] } = useProviders()
  const [choice, setChoice] = useState<ModelChoice>({ providerId: null, model: null })
  const [effort, setEffort] = useState<Effort>('high')
  useEffect(() => {
    if (!settings) return
    setChoice((c) => (c.providerId ? c : settings.ai.chat))
    setEffort(settings.ai.effort)
  }, [settings])
  const provider = providers.find((p) => p.id === choice.providerId) ?? null
  return { choice, setChoice, effort, setEffort, provider, providers }
}

export interface SendResult {
  conversation: Conversation
  userMessage: ChatMessage
  assistant: ChatMessage
}

/** 发送消息；返回会话、用户消息与（空的）助手消息占位 */
export async function sendChat(input: ChatSendRequest): Promise<SendResult> {
  const r = await api.chat.send(input)
  const assistant: ChatMessage = {
    id: r.assistantMessageId,
    conversationId: r.conversation.id,
    role: 'assistant',
    content: '',
    reasoning: null,
    citations: [],
    providerId: input.providerId,
    model: input.model,
    effort: input.effort,
    usage: null,
    status: 'streaming',
    error: null,
    skill: input.skill ?? null,
    steps: [],
    createdAt: Date.now()
  }
  return { conversation: r.conversation, userMessage: r.userMessage, assistant }
}

export const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
