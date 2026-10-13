import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DropdownMenu } from 'radix-ui'
import { toast } from 'sonner'
import {
  Sparkles,
  X,
  Pin,
  PinOff,
  SquarePen,
  ArrowUp,
  Square,
  NotebookText,
  FileText,
  TextQuote,
  Globe,
  Plus,
  Check,
  Maximize2,
  LayoutDashboard
} from 'lucide-react'
import { usePageContext } from './pageContext'
import { packetFromWorkspace, fmtTime, type ContextPacket } from '@shared/context'
import { collectTabSources, sameContextTab, withTabSources, type SelectedTab } from '@shared/browserTabContext'
import type { WorkspaceContext } from '@shared/types'
import { api, cn, modKey } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useConversations, useNote } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuTrigger, Tip } from '@/components/ui/primitives'
import { MessageItem, REPLY_EVENT } from '../chat/MessageItem'
import { errText, sendChat, useChatThread, useModelChoice } from '../chat/useChat'
import { ModelPicker } from '../ai/ModelPicker'
import { EffortPicker } from '../ai/EffortPicker'
import { WebModePicker, useWebMode } from '../retrieval/WebModePicker'
import { useAssist } from './store'
import { activeTab, aiAllowed, useBrowser } from '../browser/store'

// 工作区 AI 面板：右下角按钮 → 浮动面板 → 可钉住为右侧栏。
// 它“看得见”两侧：当前笔记（光标所在行）、当前资料（可见位置 / 选中文字），以标签显示，可逐个移除。

type ChipId = 'note' | 'source' | 'selection' | 'page'

function useContextChips(ctx: WorkspaceContext) {
  const { t } = useTranslation()
  const view = useApp((a) => a.view)
  const page = usePageContext((p) => p.page)
  const browserOpen = useApp((a) => a.browserOpen)
  const web = useBrowser(activeTab)
  const { data: note } = useNote(ctx.noteId)
  const { data: source } = useQuery({
    queryKey: ['source', ctx.sourceId],
    queryFn: () => api.sources.get(ctx.sourceId!),
    enabled: !!ctx.sourceId
  })
  const chips: { id: ChipId; icon: React.ReactNode; label: string }[] = []
  // 笔记工作区以外的页面：只附带这个页面自己的内容（之前打开的笔记、资料不算）
  if (view !== 'notes') {
    if (page) chips.push({ id: 'page', icon: <LayoutDashboard />, label: t('assist.pageContext', { title: page.title }) })
    return chips
  }
  if (ctx.noteId && note) chips.push({ id: 'note', icon: <NotebookText />, label: note.title || t('common.untitled') })
  if (ctx.sourceId && source) {
    const loc = ctx.sourceLocator?.match(/page=(\d+)/)
      ? t('assist.page', { n: ctx.sourceLocator.match(/page=(\d+)/)![1] })
      : ctx.sourceLocator?.match(/t=([\d.]+)/)
        ? fmtTime(Number(ctx.sourceLocator.match(/t=([\d.]+)/)![1]))
        : ''
    chips.push({ id: 'source', icon: <FileText />, label: `${source.title}${loc ? ` · ${loc}` : ''}` })
  }
  // 内置浏览器：还没存为资料的当前网页（发送时自动存为资料）
  if (browserOpen && !ctx.sourceId && aiAllowed(web))
    chips.push({ id: 'source', icon: <Globe />, label: t('browser.viewing', { title: web.title }) })
  if (ctx.sourceSelection || ctx.noteSelection) {
    const q = (ctx.sourceSelection || ctx.noteSelection)!
    chips.push({ id: 'selection', icon: <TextQuote />, label: `「${q.length > 18 ? q.slice(0, 18) + '…' : q}」` })
  }
  return chips
}

/** 去掉用户移除的上下文 */
function filterPacket(p: ContextPacket, off: Set<ChipId>): ContextPacket {
  let targets = p.targets
  if (off.has('selection')) targets = []
  if (off.has('note')) targets = targets.filter((a) => a.parentType !== 'note')
  if (off.has('source')) targets = targets.filter((a) => a.parentType !== 'source')
  return {
    ...p,
    targets,
    noteId: off.has('note') ? null : p.noteId,
    cursorRowId: off.has('note') ? null : p.cursorRowId,
    sourceId: off.has('source') ? null : p.sourceId,
    viewport: off.has('source') ? null : p.viewport
  }
}

const SUGGESTIONS = ['assist.s1', 'assist.s2', 'assist.s3']
/** 笔记工作区以外的页面：提示与建议问题跟着页面走（v0.6.7） */
const PAGE_SUGGESTIONS: Partial<Record<string, string[]>> = {
  today: ['assist.today1', 'assist.today2', 'assist.today3'],
  review: ['assist.review1', 'assist.review2', 'assist.review3']
}
const GENERAL_SUGGESTIONS = ['assist.general1', 'assist.general2', 'assist.general3']

export function AiPanelBody({ pinned }: { pinned: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const ctx = useApp((s) => s.context)
  const view = useApp((s) => s.view)
  const conversationId = useAssist((s) => s.panelConversationId)
  const { data: conversations = [] } = useConversations()
  const conv = conversations.find((c) => c.id === conversationId)
  const { web, setWeb } = useWebMode(conversationId, conv?.web)
  const { choice, setChoice, effort, setEffort, provider } = useModelChoice()
  const { msgs, setMsgs, streaming } = useChatThread(conversationId)
  const chips = useContextChips(ctx)
  const browserOpen = useApp((s) => s.browserOpen)
  const browserState = useBrowser((s) => s.state)
  const availableTabs = browserState.tabs.filter(aiAllowed)
  const [selectedTabs, setSelectedTabs] = useState<(SelectedTab & { title: string })[]>([])
  const [off, setOff] = useState<Set<ChipId>>(new Set())
  const [text, setText] = useState('')
  const [preparing, setPreparing] = useState(false)
  const sending = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // 换了笔记或资料：恢复全部上下文
  useEffect(() => setOff(new Set()), [ctx.noteId, ctx.sourceId])
  useEffect(() => {
    setSelectedTabs((selected) => {
      const next = browserOpen ? selected.filter((tab) => sameContextTab(tab, browserState.tabs)) : []
      return next.length === selected.length ? selected : next
    })
  }, [browserOpen, browserState])
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs])
  useEffect(() => input.current?.focus(), [])

  const send = async (q: string): Promise<void> => {
    if (!q.trim() || streaming || sending.current) return
    if (!choice.providerId || !choice.model) return void toast.error(t('chat.needModel'))
    sending.current = true
    setPreparing(true)
    try {
      const app = useApp.getState()
      let packet = filterPacket(packetFromWorkspace(app.context), off)
      if (app.view !== 'notes') {
        const page = usePageContext.getState().page
        packet = { targets: [], noteId: null, sourceId: null, page: page && !off.has('page') ? page : null }
      } else if (app.browserOpen) {
        const fresh = await api.browser.state()
        useBrowser.setState({ state: fresh })
        const web = fresh.tabs.find((tab) => tab.id === fresh.activeId) ?? null
        const selected = selectedTabs.filter((tab) => tab.id !== web?.id)
        if (!off.has('source') && aiAllowed(web) && !selected.some((tab) => tab.id === web.id)) selected.unshift(web)
        const collected = await collectTabSources(
          selected,
          async () => (await api.browser.state()).tabs,
          (tabId) => api.browser.saveSource(tabId)
        )
        const active = !off.has('source') && collected.sources.find((tab) => tab.id === web?.id)
        // 浏览器状态推送可能稍晚于导航。重新绑定当前资料，不能沿用上一网页的 sourceSelection。
        const sameSource = !!active && active.sourceId === app.context.sourceId
        packet = filterPacket(
          packetFromWorkspace({
            ...app.context,
            sourceId: active ? active.sourceId : null,
            sourceSelection: sameSource ? app.context.sourceSelection : null,
            sourceSegmentId: sameSource ? app.context.sourceSegmentId : null,
            sourceLocator: sameSource ? app.context.sourceLocator : null
          }),
          off
        )
        if (useApp.getState().browserOpen) packet = withTabSources(packet, collected.sources)
        else
          packet = filterPacket(
            packetFromWorkspace({ ...app.context, sourceId: null, sourceSelection: null, sourceSegmentId: null, sourceLocator: null }),
            off
          )
        if (collected.unavailable.length) {
          setSelectedTabs((tabs) => tabs.filter((tab) => !collected.unavailable.includes(tab.id)))
          toast(t('assist.tabsUnavailable'))
        }
      }
      const r = await sendChat({
        conversationId,
        text: q.trim(),
        providerId: choice.providerId,
        model: choice.model,
        effort,
        scope: { type: 'all' },
        // 既有会话由模式菜单立即更新；发送不写回旧渲染值，避免待回包的切换被撤销。
        ...(conversationId ? {} : { web }),
        kind: 'workspace',
        context: packet
      })
      setText('')
      setMsgs((list) => [...list, r.userMessage, r.assistant])
      if (!conversationId) {
        qc.setQueryData(['messages', r.conversation.id], [r.userMessage, r.assistant])
        useAssist.getState().setPanel({ panelConversationId: r.conversation.id })
      }
      void qc.invalidateQueries({ queryKey: ['conversations'] })
    } catch (e) {
      toast.error(errText(e))
    } finally {
      sending.current = false
      setPreparing(false)
    }
  }
  // 预填的问题（v0.7.6）：资料起始页选好了范围时直接发出，否则放进输入框等用户确认
  const draft = useAssist((s) => s.panelDraft)
  const ready = !!choice.providerId && !!choice.model
  useEffect(() => {
    // 面板刚打开时模型选择可能还没读出来：等就绪再发
    if (!draft || (useAssist.getState().panelAutoSend && !ready)) return
    const auto = useAssist.getState().panelAutoSend
    useAssist.getState().setPanel({ panelDraft: null, panelAutoSend: false })
    if (auto) void sendRef.current(draft)
    else {
      setText(draft)
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [draft, ready])

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

  return (
    <div className="flex h-full flex-col" role="complementary" aria-label={t('assist.panel')}>
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 pr-2 pl-4">
        <Sparkles className="size-4 text-accent" />
        <span className="ml-1.5 flex-1 text-sm font-medium text-fg">{t('assist.panel')}</span>
        <Tip label={t('assist.expand')} side="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('assist.expand')}
            onClick={() => {
              const id = useAssist.getState().panelConversationId
              useAssist.getState().setPanel({ panelOpen: false, panelPinned: false })
              useApp.getState().openConversation(id)
            }}
          >
            <Maximize2 />
          </Button>
        </Tip>
        <Tip label={t('chat.new')} side="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('chat.new')}
            onClick={() => useAssist.getState().setPanel({ panelConversationId: null })}
          >
            <SquarePen />
          </Button>
        </Tip>
        <Tip label={pinned ? t('assist.unpin') : t('assist.pin')} side="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={pinned ? t('assist.unpin') : t('assist.pin')}
            aria-pressed={pinned}
            onClick={() => useAssist.getState().setPanel({ panelPinned: !pinned })}
          >
            {pinned ? <PinOff /> : <Pin />}
          </Button>
        </Tip>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('common.close')}
          onClick={() => useAssist.getState().setPanel({ panelOpen: false, panelPinned: false })}
        >
          <X />
        </Button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {msgs.length === 0 ? (
          <div className="pt-4">
            <p className="text-xs leading-relaxed text-muted">{t(view === 'notes' ? 'assist.panelHint' : 'assist.pageHint')}</p>
            <div className="mt-4 flex flex-col items-start gap-2">
              {(view === 'notes' ? SUGGESTIONS : (PAGE_SUGGESTIONS[view] ?? GENERAL_SUGGESTIONS)).map((k) => (
                <button
                  key={k}
                  onClick={() => void send(t(k))}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-left text-xs text-muted transition-colors hover:border-accent hover:text-accent"
                >
                  {t(k)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          msgs.map((m, i) => <MessageItem key={m.id} m={m} compact grounded={msgs[i - 1]?.contextual} last={i === msgs.length - 1} />)
        )}
      </div>

      <div className="shrink-0 border-t border-border/70 p-3">
        {(chips.length > 0 || selectedTabs.length > 0 || (browserOpen && availableTabs.length > 1)) && (
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label={t('assist.context')}>
            {chips.map((c) => (
              <span
                key={c.id}
                className={cn(
                  'inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-1.5 text-2xs [&_svg]:size-3 [&_svg]:shrink-0',
                  off.has(c.id) ? 'border-dashed border-border text-subtle line-through' : 'border-border bg-surface text-muted'
                )}
              >
                {c.icon}
                <span className="truncate">{c.label}</span>
                <button
                  aria-label={
                    off.has(c.id) ? t('assist.restoreContext', { label: c.label }) : t('assist.removeContext', { label: c.label })
                  }
                  onClick={() =>
                    setOff((s) => {
                      const n = new Set(s)
                      if (n.has(c.id)) n.delete(c.id)
                      else n.add(c.id)
                      return n
                    })
                  }
                  className="-mr-0.5 rounded p-0.5 hover:bg-surface-hover hover:text-fg"
                >
                  <X />
                </button>
              </span>
            ))}
            {selectedTabs
              .filter((tab) => tab.id !== browserState.activeId)
              .map((tab) => (
                <span
                  key={tab.id}
                  className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-2xs text-muted [&_svg]:size-3 [&_svg]:shrink-0"
                >
                  <Globe />
                  <span className="truncate">{t('assist.tabContext', { title: tab.title })}</span>
                  <Tip label={t('assist.removeContext', { label: tab.title })}>
                    <button
                      aria-label={t('assist.removeContext', { label: tab.title })}
                      onClick={() => setSelectedTabs((tabs) => tabs.filter((item) => item.id !== tab.id))}
                      className="-mr-0.5 rounded p-0.5 hover:bg-surface-hover hover:text-fg"
                    >
                      <X />
                    </button>
                  </Tip>
                </span>
              ))}
            {browserOpen && availableTabs.length > 1 && (
              <Menu>
                <Tip label={selectedTabs.length >= 6 ? t('assist.tabsLimit') : t('assist.addTabs')}>
                  <MenuTrigger asChild>
                    <button
                      disabled={preparing}
                      aria-label={t('assist.addTabs')}
                      className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-1.5 text-2xs text-muted hover:border-accent hover:text-accent disabled:opacity-50"
                    >
                      <Plus className="size-3" />
                      {t('assist.addTabs')}
                    </button>
                  </MenuTrigger>
                </Tip>
                <MenuContent align="start" className="max-h-64 max-w-80 overflow-y-auto">
                  {availableTabs
                    .filter((tab) => tab.id !== browserState.activeId)
                    .map((tab) => {
                      const selected = selectedTabs.some((item) => item.id === tab.id)
                      return (
                        <DropdownMenu.CheckboxItem
                          key={tab.id}
                          checked={selected}
                          disabled={!selected && selectedTabs.length >= 6}
                          onSelect={(event) => event.preventDefault()}
                          onCheckedChange={(checked) =>
                            setSelectedTabs((tabs) =>
                              checked
                                ? [...tabs.filter((item) => item.id !== tab.id), { id: tab.id, url: tab.url, title: tab.title }].slice(0, 6)
                                : tabs.filter((item) => item.id !== tab.id)
                            )
                          }
                          className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-xs text-fg outline-none select-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-40"
                        >
                          <span className="grid size-4 shrink-0 place-items-center">
                            <DropdownMenu.ItemIndicator>
                              <Check className="size-3" />
                            </DropdownMenu.ItemIndicator>
                          </span>
                          <Globe className="size-3 shrink-0 text-muted" />
                          <span className="truncate">{tab.title || tab.url}</span>
                        </DropdownMenu.CheckboxItem>
                      )
                    })}
                </MenuContent>
              </Menu>
            )}
          </div>
        )}
        <div className="rounded-xl border border-border bg-surface focus-within:border-accent">
          <textarea
            ref={input}
            rows={2}
            value={text}
            disabled={preparing}
            aria-label={t('assist.panelPh')}
            placeholder={t('assist.panelPh')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send(text)
              }
            }}
            className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 text-sm leading-relaxed text-fg outline-none placeholder:text-subtle"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
            <ModelPicker compact value={choice} onChange={setChoice} />
            {provider && <EffortPicker compact kind={provider.kind} value={effort} onChange={setEffort} />}
            <span className="contents" data-testid="panel-web-mode">
              <WebModePicker value={web} onChange={setWeb} />
            </span>
            <span className="flex-1" />
            {streaming ? (
              <Button
                size="icon-sm"
                variant="secondary"
                className="rounded-full"
                onClick={() => void api.chat.stop(streaming.id)}
                aria-label={t('chat.stop')}
              >
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                variant="primary"
                className="rounded-full"
                disabled={!text.trim() || preparing}
                aria-busy={preparing}
                onClick={() => void send(text)}
                aria-label={t('chat.send')}
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 浮动面板与右下角按钮（未钉住时） */
export function AiPanelFloat() {
  const { t } = useTranslation()
  const { panelOpen, panelPinned } = useAssist()
  if (panelPinned) return null
  if (!panelOpen)
    return (
      <Tip label={`${t('assist.panel')}  ${modKey}J`} side="left">
        <button
          aria-label={t('assist.panel')}
          onClick={() => useAssist.getState().setPanel({ panelOpen: true })}
          className="absolute right-5 bottom-5 z-30 grid size-11 place-items-center rounded-full bg-accent text-accent-fg shadow-float transition-transform hover:scale-105 active:scale-95"
        >
          <Sparkles className="size-5" />
        </button>
      </Tip>
    )
  return (
    <div className="absolute right-3 bottom-3 z-30 bg-surface h-[min(640px,calc(100%-24px))] w-[min(420px,calc(100%-24px))] overflow-hidden rounded-2xl border border-border shadow-float animate-[fade-in_160ms_ease-out]">
      <AiPanelBody pinned={false} />
    </div>
  )
}
