import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, MessageSquare, Trash2, ArrowUp, Square, Settings2, Pin, EyeOff } from 'lucide-react'
import { PROVIDER_PRESETS, type Effort } from '@shared/ai'
import type { ChatMessage } from '@shared/types'
import type { ChatScope } from '@shared/schemas'
import { packetFromWorkspace } from '@shared/context'
import { useConversations, useProviders, useSettings, useEmbeddingStatus } from '@/lib/queries'
import { api, cn, formatRelative, modKey } from '@/lib/utils'
import { useApp, getWorkspaceContext } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { FloatingPanel } from '@/components/FloatingPanel'
import { CollapsibleSidebar } from '@/components/CollapsibleSidebar'
import { InkMountains } from '@/components/Illustrations'
import { ModelPicker, type ModelChoice } from '../ai/ModelPicker'
import { EffortPicker } from '../ai/EffortPicker'
import { ScopePicker } from './ScopePicker'
import { MessageItem } from './MessageItem'

const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function ChatSidebar() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { conversationId, openConversation } = useApp()
  const { data: list = [] } = useConversations()
  const remove = async (id: string, title: string): Promise<void> => {
    const ok = await confirm({
      title: t('chat.deleteTitle', { title: title || t('common.untitled') }),
      description: t('chat.deleteDesc'),
      confirmText: t('common.delete'),
      danger: true
    })
    if (!ok) return
    await api.chat.remove(id)
    if (conversationId === id) openConversation(null)
    void qc.invalidateQueries({ queryKey: ['conversations'] })
  }
  return (
    <aside className="flex h-full w-full flex-col">
      <div className="drag flex h-[52px] shrink-0 items-end justify-between px-4 pb-1.5">
        <h2 className="font-serif text-lg font-semibold tracking-wide text-fg">{t('chat.title')}</h2>
        <Button
          variant="outline"
          size="sm"
          className="no-drag h-7 rounded-full px-2.5"
          onClick={() => openConversation(null)}
          aria-label={t('chat.new')}
        >
          <Plus />
          {t('common.create')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pt-3 pb-4">
        {list.map((c) => (
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => openConversation(c.id)}
            className={cn(
              'group relative flex cursor-default items-start gap-2 rounded-lg px-3 py-2.5 transition-colors',
              c.id === conversationId ? 'bg-surface shadow-card' : 'hover:bg-surface-hover'
            )}
          >
            {c.pinned ? (
              <Pin className="mt-0.5 size-3.5 shrink-0 text-accent" />
            ) : (
              <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-subtle" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-fg">{c.title || t('common.untitled')}</p>
              <p className="mt-0.5 text-2xs text-subtle">{formatRelative(c.updatedAt, i18n.language)}</p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                void remove(c.id, c.title)
              }}
              className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger"
              aria-label={t('common.delete')}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        {list.length === 0 && <p className="px-3 py-8 text-center text-xs text-subtle">{t('chat.noConversations')}</p>}
      </div>
    </aside>
  )
}

function Composer({ busy, onSend, onStop }: { busy: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const resize = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }
  const submit = (): void => {
    if (!text.trim() || busy) return
    onSend(text.trim())
    setText('')
    requestAnimationFrame(resize)
  }
  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          resize()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={t('chat.placeholder')}
        aria-label={t('chat.placeholder')}
        className="block max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm leading-relaxed text-fg outline-none placeholder:text-subtle"
      />
      <div className="absolute right-2.5 bottom-2.5">
        {busy ? (
          <Tip label={t('chat.stop')} side="top">
            <Button size="icon-sm" variant="secondary" className="rounded-full" onClick={onStop} aria-label={t('chat.stop')}>
              <Square className="size-3 fill-current" />
            </Button>
          </Tip>
        ) : (
          <Tip label={t('chat.sendHint')} side="top">
            <Button
              size="icon-sm"
              variant="primary"
              className="rounded-full"
              disabled={!text.trim()}
              onClick={submit}
              aria-label={t('chat.send')}
            >
              <ArrowUp />
            </Button>
          </Tip>
        )}
      </div>
    </div>
  )
}

const SUGGESTIONS = ['chat.s1', 'chat.s2', 'chat.s3']

function ChatPanel() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { conversationId, openConversation, openSettings } = useApp()
  const { data: settings } = useSettings()
  const { data: providers = [] } = useProviders()
  const { data: emb } = useEmbeddingStatus()
  const { data: conversations = [] } = useConversations()
  const conv = conversations.find((c) => c.id === conversationId)
  const [choice, setChoice] = useState<ModelChoice>({ providerId: null, model: null })
  const [effort, setEffort] = useState<Effort>('high')
  const [scope, setScope] = useState<ChatScope>({ type: 'all' })
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  // 无痕只能在新对话开始前选择；已有对话沿用其设置
  const [incognitoNew, setIncognitoNew] = useState(false)
  const incognito = conv ? conv.incognito : incognitoNew
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 默认模型与思考强度来自设置
  useEffect(() => {
    if (!settings) return
    setChoice((c) => (c.providerId ? c : settings.ai.chat))
    setEffort(settings.ai.effort)
  }, [settings])
  useEffect(() => setScope(conv?.scope ?? { type: 'all' }), [conv?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: loaded } = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => api.chat.messages(conversationId!),
    enabled: !!conversationId
  })
  useEffect(() => setMsgs(conversationId ? (loaded ?? []) : []), [loaded, conversationId])

  // 流式增量与完成事件
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
    const offDone = window.jiweiEvents.on('chat:done', ({ message }) => {
      setMsgs((list) => list.map((m) => (m.id === message.id ? message : m)))
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      void qc.invalidateQueries({ queryKey: ['messages', message.conversationId] })
    })
    return () => {
      offDelta()
      offStep()
      offDone()
    }
  }, [qc])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [msgs])

  const streaming = msgs.find((m) => m.status === 'streaming')
  const provider = providers.find((p) => p.id === choice.providerId)

  const send = async (text: string): Promise<void> => {
    if (!choice.providerId || !choice.model) {
      toast.error(t('chat.needModel'))
      return
    }
    stick.current = true
    try {
      const r = await api.chat.send({
        conversationId,
        text,
        providerId: choice.providerId,
        model: choice.model,
        effort,
        scope,
        context: packetFromWorkspace(getWorkspaceContext()),
        ...(conversationId ? {} : { incognito: incognitoNew })
      })
      const assistant: ChatMessage = {
        id: r.assistantMessageId,
        conversationId: r.conversation.id,
        role: 'assistant',
        content: '',
        reasoning: null,
        citations: [],
        providerId: choice.providerId,
        model: choice.model,
        effort,
        usage: null,
        status: 'streaming',
        error: null,
        skill: null,
        steps: [],
        createdAt: Date.now()
      }
      setMsgs((list) => [...list, r.userMessage, assistant])
      if (!conversationId) {
        qc.setQueryData(['messages', r.conversation.id], [r.userMessage, assistant])
        openConversation(r.conversation.id)
      }
      void qc.invalidateQueries({ queryKey: ['conversations'] })
    } catch (e) {
      toast.error(errText(e))
    }
  }

  const noProvider = providers.length === 0 || !providers.some((p) => p.hasKey || !PROVIDER_PRESETS[p.kind].needsKey)

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-border/70 pr-[calc(var(--tb-right)+12px)] pl-6">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{conv?.title || t('chat.new')}</span>
          {incognito && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-2xs text-muted">
              <EyeOff className="size-3" />
              {t('chat.incognito')}
            </span>
          )}
        </span>
        {emb && emb.state !== 'ready' && (
          <button
            onClick={() => openSettings('ai')}
            className="no-drag inline-flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-2xs text-muted hover:text-fg"
          >
            {t('chat.kbNotReady')}
          </button>
        )}
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-[760px] space-y-7 px-8 py-8">
          {msgs.length === 0 && (
            <div className="flex flex-col items-center pt-[8vh] text-center">
              <InkMountains size={170} className="text-subtle" />
              <h2 className="mt-6 font-display text-xl font-semibold tracking-wide text-fg">{t('chat.emptyTitle')}</h2>
              <p className="mt-2 max-w-[420px] text-sm leading-relaxed text-muted">{t('chat.emptyHint')}</p>
              {noProvider ? (
                <Button variant="primary" className="mt-6" onClick={() => openSettings('ai')}>
                  <Settings2 />
                  {t('chat.setupModel')}
                </Button>
              ) : (
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((k) => (
                    <button
                      key={k}
                      onClick={() => void send(t(k))}
                      className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
                    >
                      {t(k)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {msgs.map((m) => (
            <MessageItem key={m.id} m={m} />
          ))}
        </div>
      </div>

      <div className="shrink-0 px-8 pb-5">
        <div className="paper mx-auto max-w-[760px] rounded-2xl shadow-[var(--shadow-2)]">
          <Composer busy={!!streaming} onSend={(text) => void send(text)} onStop={() => streaming && void api.chat.stop(streaming.id)} />
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
            <ModelPicker compact value={choice} onChange={setChoice} />
            {provider && <EffortPicker compact kind={provider.kind} value={effort} onChange={setEffort} />}
            <ScopePicker value={scope} onChange={setScope} />
            {!conv && (
              <Tip label={t('chat.incognitoHint')} side="top">
                <button
                  role="switch"
                  aria-checked={incognitoNew}
                  aria-label={t('chat.incognito')}
                  onClick={() => setIncognitoNew(!incognitoNew)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors',
                    incognitoNew ? 'border-fg/70 bg-fg text-bg' : 'border-border bg-surface text-muted hover:text-fg'
                  )}
                >
                  <EyeOff className="size-3.5" />
                  {t('chat.incognito')}
                </button>
              </Tip>
            )}
            <span className="ml-auto text-2xs text-subtle">{t('chat.keys', { mod: modKey })}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ChatView() {
  return (
    <div className="flex h-full">
      <CollapsibleSidebar>
        <ChatSidebar />
      </CollapsibleSidebar>
      <FloatingPanel flushLeft>
        <ChatPanel />
      </FloatingPanel>
    </div>
  )
}
