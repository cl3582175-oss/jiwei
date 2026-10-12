import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, MessageSquare, Trash2, ArrowUp, Square, Settings2, Pin, EyeOff } from 'lucide-react'
import { PROVIDER_PRESETS } from '@shared/ai'
import type { ChatScope } from '@shared/schemas'
import { packetFromWorkspace } from '@shared/context'
import { useConversations, useProviders, useEmbeddingStatus } from '@/lib/queries'
import { api, cn, formatRelative, modKey } from '@/lib/utils'
import { useApp, getWorkspaceContext } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { FloatingPanel } from '@/components/FloatingPanel'
import { PageSidebar, SidebarToggle, useWindowWidth } from '@/components/PageSidebar'
import { InkMountains } from '@/components/Illustrations'
import { ModelPicker } from '../ai/ModelPicker'
import { EffortPicker } from '../ai/EffortPicker'
import { ScopePicker } from './ScopePicker'
import { MessageItem, REPLY_EVENT } from './MessageItem'
import { errText, sendChat, useChatThread, useModelChoice } from './useChat'

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
        <div className="no-drag flex items-center gap-0.5">
          <SidebarToggle />
          <Button
            variant="outline"
            size="sm"
            className="ml-1 h-7 rounded-full px-2.5"
            onClick={() => openConversation(null)}
            aria-label={t('chat.new')}
          >
            <Plus />
            {t('common.create')}
          </Button>
        </div>
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

export function Composer({
  busy,
  onSend,
  onStop,
  placeholder,
  prefill
}: {
  busy: boolean
  onSend: (text: string) => void
  onStop: () => void
  placeholder?: string
  /** 预填的文字（角色起步卡）：只填入输入框，由用户检查后发送 */
  prefill?: string
}) {
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
  useEffect(() => {
    if (!prefill) return
    setText(prefill)
    requestAnimationFrame(() => {
      resize()
      ref.current?.setSelectionRange(prefill.length, prefill.length)
    })
  }, [prefill])
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
        placeholder={placeholder ?? t('chat.placeholder')}
        aria-label={placeholder ?? t('chat.placeholder')}
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
  const { data: providers = [] } = useProviders()
  const { data: emb } = useEmbeddingStatus()
  const { data: conversations = [] } = useConversations()
  const conv = conversations.find((c) => c.id === conversationId)
  const { choice, setChoice, effort, setEffort, provider } = useModelChoice()
  const [scope, setScope] = useState<ChatScope>({ type: 'all' })
  const { msgs, setMsgs, streaming } = useChatThread(conversationId)
  // 无痕只能在新对话开始前选择；已有对话沿用其设置
  const [incognitoNew, setIncognitoNew] = useState(false)
  const incognito = conv ? conv.incognito : incognitoNew
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => setScope(conv?.scope ?? { type: 'all' }), [conv?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [msgs])

  const send = async (text: string, page?: { title: string; text: string }): Promise<void> => {
    if (!choice.providerId || !choice.model) {
      toast.error(t('chat.needModel'))
      return
    }
    stick.current = true
    try {
      const { conversation, userMessage, assistant } = await sendChat({
        conversationId,
        text,
        providerId: choice.providerId,
        model: choice.model,
        effort,
        scope,
        context: { ...packetFromWorkspace(getWorkspaceContext()), page: page ?? null },
        ...(conversationId ? {} : { incognito: incognitoNew })
      })
      const r = { conversation, userMessage }
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
  // 点了 AI 选择题的选项（v0.7.6）：当作用户的回答发出
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    const onReply = (e: Event): void => {
      const d = (e as CustomEvent<{ conversationId: string; text: string }>).detail
      if (d.conversationId === conversationId) void sendRef.current(d.text)
    }
    window.addEventListener(REPLY_EVENT, onReply)
    return () => window.removeEventListener(REPLY_EVENT, onReply)
  }, [conversationId])

  // 「今日」输入框与晨报回复：进入助手页后自动发送（模型就绪后发送一次）
  const draftSent = useRef(false)
  const [prefill, setPrefill] = useState('')
  useEffect(() => {
    const intent = useApp.getState().takeStarterIntent('chat')
    if (intent) setPrefill(intent.text)
  }, [])
  useEffect(() => {
    if (draftSent.current || !choice.providerId || !choice.model || !useApp.getState().assistantDraft) return
    const d = useApp.getState().takeAssistantDraft()
    if (!d) return
    draftSent.current = true
    void send(d.text, d.context ? { title: t('today.briefing'), text: d.context } : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice.providerId, choice.model])

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
          {msgs.map((m, i) => (
            <MessageItem key={m.id} m={m} grounded={msgs[i - 1]?.contextual} last={i === msgs.length - 1} />
          ))}
        </div>
      </div>

      <div className="shrink-0 px-8 pb-5">
        <div className="paper mx-auto max-w-[760px] rounded-2xl shadow-[var(--shadow-2)]">
          <Composer
            prefill={prefill}
            busy={!!streaming}
            onSend={(text) => void send(text)}
            onStop={() => streaming && void api.chat.stop(streaming.id)}
          />
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
  const { t } = useTranslation()
  const narrow = useWindowWidth() < 1100
  return (
    <div className="flex h-full">
      <PageSidebar page="chat" auto={narrow} label={t('chat.history')}>
        <ChatSidebar />
      </PageSidebar>
      <FloatingPanel flushLeft>
        <ChatPanel />
      </FloatingPanel>
    </div>
  )
}
