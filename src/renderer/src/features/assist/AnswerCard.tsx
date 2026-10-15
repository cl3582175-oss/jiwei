import { useAttachments } from '../attachments/useAttachments'
import { AttachmentDropZone } from '../attachments/AttachmentInput'
import { Composer as ChatComposer } from '../chat/ChatView'
import { useModelChoice } from '../chat/useChat'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import {
  X,
  NotebookPen,
  Copy,
  Check,
  ArrowUp,
  PanelRightOpen,
  Lightbulb,
  BookOpenText,
  Languages,
  MessageCircleQuestion,
  PenLine
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { MessageItem, REPLY_EVENT, type ReplyDetail } from '../chat/MessageItem'
import { useChatThread } from '../chat/useChat'
import { useAssist, isRevise, type AskAction } from './store'
import { askInline, followUp, saveToNote, stripCites } from './actions'

// 就地答复卡片：浮在选区旁，流式显示回答；可追问、存入笔记、转到 AI 面板继续。

const ICON: Record<AskAction, React.ReactNode> = {
  explain: <Lightbulb />,
  clarify: <BookOpenText />,
  translate: <Languages />,
  grammar: <BookOpenText />,
  ask: <MessageCircleQuestion />,
  shorten: <PenLine />,
  expand: <PenLine />,
  simplify: <PenLine />,
  fix: <PenLine />,
  list: <PenLine />,
  revise: <PenLine />,
  remap: <PenLine />
}
const W = 420

/** 存入笔记时的线索：解释 / 提问用问题本身；翻译用原文；讲明白用“「原文」讲的是什么？” */
function cueFor(action: AskAction, question: string, quote: string): string {
  const q = quote.length > 40 ? quote.slice(0, 40) + '…' : quote
  if ((action === 'translate' || action === 'grammar') && q) return action === 'grammar' ? i18n.t('reading.grammarCue', { q }) : q
  if (action === 'clarify' && q) return i18n.t('assist.cueClarify', { q })
  return question
}

function Composer({ placeholder, onSend, autoFocus }: { placeholder: string; onSend: (t: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  const submit = (): void => {
    if (!text.trim()) return
    onSend(text.trim())
    setText('')
  }
  return (
    <div className="flex items-end gap-2 rounded-xl border border-border bg-surface px-3 py-2 focus-within:border-accent">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        className="max-h-24 min-h-5 flex-1 resize-none bg-transparent text-sm leading-relaxed text-fg outline-none placeholder:text-subtle"
      />
      <Button
        size="icon-sm"
        variant="primary"
        className="size-6 rounded-full"
        disabled={!text.trim()}
        onClick={submit}
        aria-label={placeholder}
      >
        <ArrowUp className="size-3.5" />
      </Button>
    </div>
  )
}

export function AnswerCard() {
  const { t } = useTranslation()
  const card = useAssist((s) => s.card)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const { msgs, streaming } = useChatThread(card?.conversationId ?? null)
  const attachments = useAttachments({ kind: 'inline', conversationId: card?.conversationId })
  const { provider } = useModelChoice()
  useEffect(() => {
    if (!card?.conversationId) return
    const onReply = (e: Event): void => {
      const d = (e as CustomEvent<ReplyDetail>).detail
      if (d.conversationId === card.conversationId && !streaming)
        void followUp(d.conversationId, d.text, card.anchor, card.extra, d.uiEvent)
    }
    window.addEventListener(REPLY_EVENT, onReply)
    return () => window.removeEventListener(REPLY_EVENT, onReply)
  }, [card, streaming])

  // 位置：优先放在选区下方，放不下则放上方；始终在窗口内
  useLayoutEffect(() => {
    if (!card || !ref.current) return setPos(null)
    const h = ref.current.offsetHeight
    const { rect } = card
    let left = Math.min(Math.max(12, rect.x + rect.w / 2 - W / 2), window.innerWidth - W - 12)
    const below = rect.y + rect.h + 10
    let top = below + h < window.innerHeight - 12 ? below : Math.max(12, rect.y - 10 - h)
    // 修改笔记：差异会出现在原文下方，卡片让开——优先放在选区左侧（线索栏上方），其次放在上方
    if (card.anchor.parentType === 'note' && isRevise(card.action)) {
      const clampTop = Math.min(Math.max(12, rect.y), window.innerHeight - h - 12)
      if (rect.x - W - 16 >= 12) {
        left = rect.x - W - 16
        top = clampTop
      } else if (rect.y - h - 10 >= 12) top = rect.y - h - 10
    }
    setPos((p) => (p && Math.abs(p.top - top) < 2 && p.left === left ? p : { left, top }))
  }, [card, msgs])

  useEffect(() => {
    if (!card) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useAssist.getState().closeCard()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [card])

  if (!card) return null
  const quote = card.anchor.quote ?? ''
  const composing = !card.conversationId && !card.question
  // 来自笔记的提问：不再“存入笔记”；修改以行内差异显示在笔记中，逐条确认
  const fromNote = card.anchor.parentType === 'note'
  // 第一条用户消息就是卡片标题，不重复显示
  const shown = msgs.filter((m, i) => !(i === 0 && m.role === 'user'))
  const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.status === 'done' && m.content)
  const busy = !!streaming || (!!card.question && !card.conversationId)

  const copy = (): void => {
    if (!answer) return
    void navigator.clipboard.writeText(stripCites(answer.content))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const toPanel = (): void => {
    useAssist.getState().setPanel({ panelOpen: true, panelConversationId: card.conversationId })
    useAssist.getState().closeCard()
  }

  return (
    <AttachmentDropZone controller={attachments} className="fixed z-50" style={{ width: W, left: pos?.left ?? -9999, top: pos?.top ?? 0 }}>
      <div
        ref={ref}
        role="dialog"
        aria-label={t('assist.card')}
        className="paper flex max-h-[min(62vh,560px)] flex-col overflow-hidden rounded-2xl border border-border shadow-float animate-[fade-in_140ms_ease-out]"
      >
        <header className="flex items-start gap-2.5 border-b border-border/70 px-4 py-3">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent [&_svg]:size-3.5">
            {ICON[card.action]}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-fg">{card.question || t(`assist.actions.${card.action}`)}</p>
            {quote && <p className="mt-0.5 line-clamp-2 font-kai text-2xs leading-relaxed text-muted">「{quote}」</p>}
          </div>
          {card.conversationId && (
            <Tip label={t('assist.toPanel')} side="bottom">
              <Button size="icon-sm" variant="ghost" onClick={toPanel} aria-label={t('assist.toPanel')}>
                <PanelRightOpen />
              </Button>
            </Tip>
          )}
          <Button size="icon-sm" variant="ghost" onClick={() => useAssist.getState().closeCard()} aria-label={t('common.close')}>
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
          {composing ? (
            <div className="space-y-3">
              {card.image && (
                <img src={card.image} alt={t('assist.region')} className="max-h-40 rounded-lg border border-border object-contain" />
              )}
              {(card.anchor.kind === 'region' || card.anchor.kind === 'media-range') && (
                <div className="flex flex-wrap gap-1.5">
                  {(['explain', 'clarify', 'translate'] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => void askInline(a, card.anchor, card.rect, undefined, card.image)}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-xs text-fg hover:border-accent hover:text-accent [&_svg]:size-3.5 [&_svg]:text-accent"
                    >
                      {ICON[a]}
                      {t(`assist.qRegion.${a}`)}
                    </button>
                  ))}
                </div>
              )}
              <Composer
                autoFocus
                placeholder={
                  card.action === 'remap' ? t('embeds.aiEditPh') : card.action === 'revise' ? t('assist.revisePh') : t('assist.askPh')
                }
                onSend={(text) =>
                  void askInline(isRevise(card.action) ? card.action : 'ask', card.anchor, card.rect, text, card.image, card.extra)
                }
              />
            </div>
          ) : shown.length === 0 ? (
            <div className="space-y-2 py-1">
              <div className="h-3 w-3/4 animate-pulse rounded bg-sunken" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-sunken" />
            </div>
          ) : (
            shown.map((m, i) => <MessageItem key={m.id} m={m} compact replyRestricted last={i === shown.length - 1} />)
          )}
        </div>

        {card.conversationId && (
          <footer className={cn('space-y-2 border-t border-border/70 px-4 py-3', busy && 'opacity-60')}>
            <div className="flex items-center gap-1.5">
              {fromNote && isRevise(card.action) && (
                <span className="mr-auto text-2xs leading-relaxed text-muted">
                  {t(card.action === 'remap' ? 'assist.remapHint' : 'assist.reviseHint')}
                </span>
              )}
              <Button
                size="sm"
                variant="primary"
                className={cn(fromNote && 'hidden')}
                disabled={!answer}
                onClick={() =>
                  answer &&
                  void saveToNote({
                    conversationId: card.conversationId ?? undefined,
                    cue: cueFor(card.action, card.question, quote),
                    answer: answer.content,
                    anchor: card.anchor,
                    model: answer.model
                  }).then(() => useAssist.getState().closeCard())
                }
              >
                <NotebookPen />
                {t('assist.saveToNote')}
              </Button>
              <Button size="sm" variant="ghost" disabled={!answer} onClick={copy}>
                {copied ? <Check /> : <Copy />}
                {t('chat.copy')}
              </Button>
            </div>
            {!busy && (
              <ChatComposer
                conversationId={card.conversationId}
                placeholder={t('assist.followUp')}
                attachments={attachments}
                provider={provider}
                busy={!!streaming}
                onStop={() => {}}
                onSend={async (text) => {
                  const ids = attachments.ids()
                  const ok = await followUp(card.conversationId!, text, card.anchor, card.extra, undefined, ids)
                  if (ok) attachments.clear(ids)
                  return ok
                }}
              />
            )}
          </footer>
        )}
      </div>
    </AttachmentDropZone>
  )
}
