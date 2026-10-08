import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Sparkles, X, Pin, PinOff, SquarePen, ArrowUp, Square, NotebookText, FileText, TextQuote } from 'lucide-react'
import { packetFromWorkspace, fmtTime, type ContextPacket } from '@shared/context'
import type { WorkspaceContext } from '@shared/types'
import { api, cn, modKey } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useNote } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { MessageItem } from '../chat/MessageItem'
import { errText, sendChat, useChatThread, useModelChoice } from '../chat/useChat'
import { ModelPicker } from '../ai/ModelPicker'
import { EffortPicker } from '../ai/EffortPicker'
import { useAssist } from './store'

// 工作区 AI 面板：右下角按钮 → 浮动面板 → 可钉住为右侧栏。
// 它“看得见”两侧：当前笔记（光标所在行）、当前资料（可见位置 / 选中文字），以标签显示，可逐个移除。

type ChipId = 'note' | 'source' | 'selection'

function useContextChips(ctx: WorkspaceContext) {
  const { t } = useTranslation()
  const { data: note } = useNote(ctx.noteId)
  const { data: source } = useQuery({
    queryKey: ['source', ctx.sourceId],
    queryFn: () => api.sources.get(ctx.sourceId!),
    enabled: !!ctx.sourceId
  })
  const chips: { id: ChipId; icon: React.ReactNode; label: string }[] = []
  if (ctx.noteId && note) chips.push({ id: 'note', icon: <NotebookText />, label: note.title || t('common.untitled') })
  if (ctx.sourceId && source) {
    const loc = ctx.sourceLocator?.match(/page=(\d+)/)
      ? t('assist.page', { n: ctx.sourceLocator.match(/page=(\d+)/)![1] })
      : ctx.sourceLocator?.match(/t=([\d.]+)/)
        ? fmtTime(Number(ctx.sourceLocator.match(/t=([\d.]+)/)![1]))
        : ''
    chips.push({ id: 'source', icon: <FileText />, label: `${source.title}${loc ? ` · ${loc}` : ''}` })
  }
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

export function AiPanelBody({ pinned }: { pinned: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const ctx = useApp((s) => s.context)
  const conversationId = useAssist((s) => s.panelConversationId)
  const { choice, setChoice, effort, setEffort, provider } = useModelChoice()
  const { msgs, setMsgs, streaming } = useChatThread(conversationId)
  const chips = useContextChips(ctx)
  const [off, setOff] = useState<Set<ChipId>>(new Set())
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // 换了笔记或资料：恢复全部上下文
  useEffect(() => setOff(new Set()), [ctx.noteId, ctx.sourceId])
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs])
  useEffect(() => input.current?.focus(), [])

  const send = async (q: string): Promise<void> => {
    if (!q.trim() || streaming) return
    if (!choice.providerId || !choice.model) return void toast.error(t('chat.needModel'))
    setText('')
    try {
      const r = await sendChat({
        conversationId,
        text: q.trim(),
        providerId: choice.providerId,
        model: choice.model,
        effort,
        scope: { type: 'all' },
        kind: 'workspace',
        context: filterPacket(packetFromWorkspace(useApp.getState().context), off)
      })
      setMsgs((list) => [...list, r.userMessage, r.assistant])
      if (!conversationId) {
        qc.setQueryData(['messages', r.conversation.id], [r.userMessage, r.assistant])
        useAssist.getState().setPanel({ panelConversationId: r.conversation.id })
      }
    } catch (e) {
      toast.error(errText(e))
    }
  }

  return (
    <div className="flex h-full flex-col" role="complementary" aria-label={t('assist.panel')}>
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 pr-2 pl-4">
        <Sparkles className="size-4 text-accent" />
        <span className="ml-1.5 flex-1 text-sm font-medium text-fg">{t('assist.panel')}</span>
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
            <p className="text-xs leading-relaxed text-muted">{t('assist.panelHint')}</p>
            <div className="mt-4 flex flex-col items-start gap-2">
              {SUGGESTIONS.map((k) => (
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
          msgs.map((m) => <MessageItem key={m.id} m={m} compact />)
        )}
      </div>

      <div className="shrink-0 border-t border-border/70 p-3">
        {chips.length > 0 && (
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
          </div>
        )}
        <div className="rounded-xl border border-border bg-surface focus-within:border-accent">
          <textarea
            ref={input}
            rows={2}
            value={text}
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
                disabled={!text.trim()}
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
    <div className="glass absolute right-3 bottom-3 z-30 h-[min(640px,calc(100%-24px))] w-[min(420px,calc(100%-24px))] overflow-hidden rounded-2xl border border-border shadow-float animate-[fade-in_160ms_ease-out]">
      <AiPanelBody pinned={false} />
    </div>
  )
}
