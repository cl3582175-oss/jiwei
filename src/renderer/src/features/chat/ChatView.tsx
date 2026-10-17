import { attachmentContext } from '../attachments/context'
import { useAttachments } from '../attachments/useAttachments'
import { AttachmentDropZone } from '../attachments/AttachmentInput'
import { ConversationAttachments } from '../attachments/ConversationAttachments'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Settings2, EyeOff } from 'lucide-react'
import { PROVIDER_PRESETS } from '@shared/ai'
import type { ChatScope } from '@shared/schemas'
import { packetFromWorkspace } from '@shared/context'
import { useConversations, useProviders, useEmbeddingStatus, useChatProjects } from '@/lib/queries'
import { api, cn, modKey } from '@/lib/utils'
import { useApp, getWorkspaceContext } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { FloatingPanel } from '@/components/FloatingPanel'
import { PageSidebar, useWindowWidth } from '@/components/PageSidebar'
import { InkMountains } from '@/components/Illustrations'
import { ModelPicker } from '../ai/ModelPicker'
import { EffortPicker } from '../ai/EffortPicker'
import { ScopePicker } from './ScopePicker'
import { WebModePicker, useWebMode } from '../retrieval/WebModePicker'
import { MessageItem, REPLY_EVENT, type ReplyDetail } from './MessageItem'
import type { UiEvent } from '@shared/ui/events'
import { errText, sendChat, useChatThread } from './useChat'
import { useChatModelChoice } from './modelChoice'
import { ChatSidebar } from './sidebar/ChatSidebar'
import { ProjectHome } from './ProjectHome'
import { Composer } from './Composer'
export { Composer } from './Composer'

const SUGGESTIONS = ['chat.s1', 'chat.s2', 'chat.s3']

function ChatPanel() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { conversationId, chatNewProjectId, chatMessageId, openConversation, openSettings } = useApp()
  const { data: providers = [] } = useProviders()
  const { data: emb } = useEmbeddingStatus()
  const { data: conversations = [] } = useConversations()
  const conv = conversations.find((c) => c.id === conversationId)
  const { data: projects = [] } = useChatProjects()
  const projectId = conv?.projectId ?? chatNewProjectId
  const project = projects.find((p) => p.id === projectId)
  const { web, setWeb } = useWebMode(conversationId, conv?.web)
  const { choice, setChoice, effort, setEffort, provider, rememberConversation } = useChatModelChoice(conversationId, projectId)
  const [scope, setScope] = useState<ChatScope>({ type: 'all' })
  const scopeExplicit = useRef(false)
  const { msgs, setMsgs, streaming } = useChatThread(conversationId)
  // 无痕只能在新对话开始前选择；已有对话沿用其设置
  const [incognitoNew, setIncognitoNew] = useState(false)
  const incognito = conv ? conv.incognito : incognitoNew
  const attachments = useAttachments({ kind: 'chat', conversationId, incognito })
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    scopeExplicit.current = false
  }, [conversationId, chatNewProjectId])

  useEffect(() => {
    if (!scopeExplicit.current) setScope(conv?.scope ?? { type: project?.libraryScope === 'none' ? 'none' : 'all' })
  }, [conv?.id, project?.id, project?.libraryScope]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [msgs])

  useEffect(() => {
    if (!chatMessageId) return
    const el = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(
      (item) => item.dataset.messageId === chatMessageId
    )
    if (!el) return
    stick.current = false
    el.scrollIntoView({ block: 'center' })
    useApp.setState({ chatMessageId: null })
  }, [chatMessageId, msgs])

  const send = async (text: string, page?: { title: string; text: string }, uiEvent?: UiEvent): Promise<boolean> => {
    if (!choice.providerId || !choice.model) {
      toast.error(t('chat.needModel'))
      return false
    }
    const attachmentIds = attachments.ids()
    stick.current = true
    const skill = starterSkill.current
    starterSkill.current = undefined
    try {
      const { conversation, userMessage, assistant } = await sendChat({
        conversationId,
        ...(!conversationId && chatNewProjectId ? { projectId: chatNewProjectId } : {}),
        text,
        attachments: attachmentIds,
        uiEvent,
        ...(skill ? { skill } : {}),
        providerId: choice.providerId,
        model: choice.model,
        effort,
        // 未手动修改时由主进程读取项目默认或已有对话范围，避免加载期间误放宽范围。
        ...(scopeExplicit.current ? { scope } : {}),
        // 既有会话由模式菜单立即更新；发送不写回旧渲染值，避免待回包的切换被撤销。
        ...(conversationId ? {} : { web }),
        context: await attachmentContext(
          { ...packetFromWorkspace(getWorkspaceContext()), page: page ?? null },
          conversationId,
          attachmentIds
        ),
        ...(conversationId ? {} : { incognito: incognitoNew })
      })
      rememberConversation(conversation.id)
      attachments.clear(attachmentIds)
      if (
        useApp.getState().conversationId !== conversationId ||
        useApp.getState().chatNewProjectId !== chatNewProjectId ||
        useApp.getState().chatProjectId
      )
        return true
      const r = { conversation, userMessage }
      setMsgs((list) => [...list, r.userMessage, assistant])
      if (!conversationId) {
        qc.setQueryData(['messages', r.conversation.id], [r.userMessage, assistant])
        qc.setQueryData<import('@shared/types').Conversation[]>(['conversations'], (items = []) => [
          r.conversation,
          ...items.filter((c) => c.id !== r.conversation.id)
        ])
        openConversation(r.conversation.id)
      }
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      void qc.invalidateQueries({ queryKey: ['projectConversations'] })
      return true
    } catch (e) {
      toast.error(errText(e))
      return false
    }
  }
  // 点了 AI 选择题的选项（v0.7.6）：当作用户的回答发出
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    const onReply = (e: Event): void => {
      const d = (e as CustomEvent<ReplyDetail>).detail
      if (d.conversationId === conversationId) void sendRef.current(d.text, undefined, d.uiEvent)
    }
    window.addEventListener(REPLY_EVENT, onReply)
    return () => window.removeEventListener(REPLY_EVENT, onReply)
  }, [conversationId])

  // 「今日」输入框与晨报回复：进入助手页后自动发送（模型就绪后发送一次）
  const draftSent = useRef(false)
  const [prefill, setPrefill] = useState('')
  // 起步卡指定的技能：第一条消息直接用它，不靠模型从技能目录里匹配
  const starterSkill = useRef<string | undefined>(undefined)
  useEffect(() => {
    const intent = useApp.getState().takeStarterIntent('chat')
    if (!intent) return
    setPrefill(intent.text)
    starterSkill.current = intent.skill
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
    <AttachmentDropZone controller={attachments} className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-border/70 pr-[calc(var(--tb-right)+12px)] pl-6">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">
            {conv?.title || (project ? t('projects.newChatIn', { name: project.name }) : t('chat.new'))}
          </span>
          {incognito && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-2xs text-muted">
              <EyeOff className="size-3" />
              {t('chat.incognito')}
            </span>
          )}
        </span>
        <ConversationAttachments conversationId={conversationId} incognito={incognito} />
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
                <Button variant="primary" className="mt-6" onClick={() => useApp.getState().openModelSetup()}>
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
            <div key={m.id} data-message-id={m.id}>
              <MessageItem m={m} grounded={msgs[i - 1]?.contextual} last={i === msgs.length - 1} />
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 px-8 pb-5">
        <div className="paper mx-auto max-w-[760px] rounded-2xl shadow-[var(--shadow-2)]">
          <Composer
            conversationId={conversationId}
            prefill={prefill}
            placeholder={project && !conversationId ? t('projects.newChatIn', { name: project.name }) : undefined}
            busy={!!streaming}
            attachments={attachments}
            provider={provider}
            newConversation={!conversationId}
            onSend={(text) => send(text)}
            onStop={() => streaming && void api.chat.stop(streaming.id)}
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
            <ModelPicker compact value={choice} onChange={setChoice} />
            {provider && <EffortPicker compact kind={provider.kind} value={effort} onChange={setEffort} />}
            <ScopePicker
              value={scope}
              onChange={(next) => {
                scopeExplicit.current = true
                setScope(next)
              }}
            />
            <span className="contents" data-testid="chat-web-mode">
              <WebModePicker value={web} onChange={setWeb} />
            </span>
            {!conv && (
              <Tip label={t('chat.incognitoHint')} side="top">
                <button
                  role="switch"
                  aria-checked={incognitoNew}
                  aria-label={t('chat.incognito')}
                  disabled={!!attachments.items.length}
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
    </AttachmentDropZone>
  )
}

export function ChatView() {
  const { t } = useTranslation()
  const narrow = useWindowWidth() < 1100
  const { chatProjectId } = useApp()
  return (
    <div className="flex h-full">
      <PageSidebar page="chat" auto={narrow} label={t('chat.history')}>
        <ChatSidebar />
      </PageSidebar>
      <FloatingPanel flushLeft>{chatProjectId ? <ProjectHome key={chatProjectId} id={chatProjectId} /> : <ChatPanel />}</FloatingPanel>
    </div>
  )
}
