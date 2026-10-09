import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronLeft, GraduationCap, Loader2, CheckCircle2, CircleHelp, CircleAlert, NotebookPen, RotateCcw, Flag } from 'lucide-react'
import { PROVIDER_PRESETS, type Effort } from '@shared/ai'
import type { FeynmanReport } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { FloatingPanel } from '@/components/FloatingPanel'
import { MessageItem } from '../chat/MessageItem'
import { Composer } from '../chat/ChatView'
import { errText, sendChat, useChatThread, useModelChoice } from '../chat/useChat'

// 费曼练习：把一个概念讲给“完全不懂的学生小微”听；小微一次问一个问题，帮你发现没讲清楚的地方。
// 讲完后诊断：讲清楚了什么、漏洞、错误，以及可以补进笔记（进入复习）的问题。

const LEVEL_TONE: Record<FeynmanReport['level'], string> = {
  weak: 'bg-danger-soft text-danger',
  learning: 'bg-[#b8862b]/12 text-[#9a6f1f]',
  solid: 'bg-accent-soft text-accent'
}

function Report({ r, conversationId, onAgain }: { r: FeynmanReport; conversationId: string; onAgain: () => void }) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<Set<number>>(() => new Set(r.cues.map((_, i) => i)))
  const [added, setAdded] = useState<string | null>(null)
  const add = async (): Promise<void> => {
    try {
      const res = await api.feynman.addCues(conversationId, [...picked])
      setAdded(res.noteId)
      toast.success(t('feynman.added', { count: picked.size }))
    } catch (e) {
      toast.error(errText(e))
    }
  }
  const section = (icon: React.ReactNode, title: string, tone: string, items: React.ReactNode[]) =>
    items.length > 0 && (
      <div className="mt-5">
        <p className={cn('flex items-center gap-1.5 text-xs font-medium [&_svg]:size-3.5', tone)}>
          {icon}
          {title}
        </p>
        <ul className="mt-2 space-y-1.5 pl-5 text-sm leading-relaxed text-fg">{items}</ul>
      </div>
    )
  return (
    <section className="mt-8 rounded-2xl border border-border bg-surface px-7 py-6 shadow-card" data-testid="feynman-report">
      <div className="flex items-center gap-3">
        <h2 className="font-serif text-lg font-semibold text-fg">{t('feynman.reportTitle')}</h2>
        <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', LEVEL_TONE[r.level])}>{t(`memory.concept.${r.level}`)}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted">{r.verdict}</p>
      {section(
        <CheckCircle2 />,
        t('feynman.clear'),
        'text-accent',
        r.clear.map((c, i) => (
          <li key={i} className="list-disc">
            {c}
          </li>
        ))
      )}
      {section(
        <CircleHelp />,
        t('feynman.gaps'),
        'text-[#9a6f1f]',
        r.gaps.map((g, i) => (
          <li key={i} className="list-disc">
            <span className="font-medium">{g.point}</span>
            <span className="block text-muted">{g.hint}</span>
          </li>
        ))
      )}
      {section(
        <CircleAlert />,
        t('feynman.wrong'),
        'text-danger',
        r.misconceptions.map((m, i) => (
          <li key={i} className="list-disc">
            {m}
          </li>
        ))
      )}
      {r.cues.length > 0 && (
        <div className="mt-6 rounded-xl bg-sunken/70 px-4 py-4">
          <p className="text-xs font-medium text-fg">{t('feynman.cuesTitle')}</p>
          <p className="mt-0.5 text-2xs text-subtle">{t('feynman.cuesHint')}</p>
          <ul className="mt-3 space-y-2">
            {r.cues.map((c, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--accent)]"
                    checked={picked.has(i)}
                    disabled={!!added}
                    onChange={(e) =>
                      setPicked((s) => {
                        const n = new Set(s)
                        if (e.target.checked) n.add(i)
                        else n.delete(i)
                        return n
                      })
                    }
                  />
                  <span className="text-sm leading-relaxed">
                    <span className="font-medium text-fg">{c.question}</span>
                    <span className="block text-muted">{c.answer}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onAgain}>
          <RotateCcw />
          {t('feynman.again')}
        </Button>
        {added ? (
          <Button variant="outline" onClick={() => useApp.getState().openNote(added)}>
            <NotebookPen />
            {t('feynman.openNote')}
          </Button>
        ) : (
          r.cues.length > 0 && (
            <Button variant="primary" disabled={!picked.size} onClick={() => void add()}>
              <NotebookPen />
              {t('feynman.addCues', { count: picked.size })}
            </Button>
          )
        )}
      </div>
    </section>
  )
}

export function FeynmanView() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const session = useApp((s) => s.feynman)
  const conversationId = session?.conversationId ?? null
  const { choice, provider } = useModelChoice()
  const { msgs, setMsgs, streaming } = useChatThread(conversationId)
  const { data: conv } = useQuery({
    queryKey: ['feynman', conversationId],
    queryFn: () => api.feynman.get(conversationId!),
    enabled: !!conversationId
  })
  const [finishing, setFinishing] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const report = conv?.feynman?.report ?? null

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, report, finishing])

  if (!session) return null
  const concept = session.concept

  // 学生的回复要快：关闭思考（服务商不支持关闭时取最低档）
  const effort = (): Effort => {
    const levels = provider ? PROVIDER_PRESETS[provider.kind].efforts : (['off'] as Effort[])
    return levels.includes('off') ? 'off' : levels[0]
  }
  const send = async (text: string): Promise<void> => {
    if (streaming) return
    if (!choice.providerId || !choice.model) return void toast.error(t('chat.needModel'))
    try {
      const r = await sendChat({
        conversationId,
        text,
        providerId: choice.providerId,
        model: choice.model,
        effort: effort(),
        scope: { type: 'none' },
        kind: 'feynman',
        feynman: { concept, noteId: session.noteId, cardId: session.cardId }
      })
      setMsgs((list) => [...list, r.userMessage, r.assistant])
      if (!conversationId) {
        qc.setQueryData(['messages', r.conversation.id], [r.userMessage, r.assistant])
        useApp.getState().setFeynmanConversation(r.conversation.id)
      }
    } catch (e) {
      toast.error(errText(e))
    }
  }
  const finish = async (): Promise<void> => {
    if (!conversationId) return
    setFinishing(true)
    try {
      const r = await api.feynman.finish(conversationId)
      qc.setQueryData(['feynman', conversationId], (c: typeof conv) => (c ? { ...c, feynman: { ...c.feynman!, report: r } } : c))
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setFinishing(false)
    }
  }
  const again = (): void => useApp.getState().startFeynman({ concept, noteId: session.noteId, cardId: session.cardId })
  const replied = msgs.some((m) => m.role === 'assistant' && m.status === 'done')

  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-4">
        <Button size="icon-sm" variant="ghost" className="no-drag" aria-label={t('nav.back')} onClick={() => useApp.getState().back()}>
          <ChevronLeft />
        </Button>
        <GraduationCap className="size-4 text-accent" />
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('feynman.title')}</h1>
        <span className="truncate rounded-full bg-sunken px-2.5 py-0.5 text-xs text-muted">{concept}</span>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-8 pt-8 pb-10">
          <div className="text-center">
            <h2 className="font-serif text-xl font-semibold text-fg">{t('feynman.heading', { concept })}</h2>
            <p className="mx-auto mt-2 max-w-[520px] text-sm leading-relaxed text-muted">{t('feynman.intro')}</p>
          </div>
          <div className="mt-8 flex items-start gap-3" data-testid="feynman-opener">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
              <GraduationCap className="size-4" />
            </span>
            <p className="rounded-2xl rounded-tl-sm bg-sunken px-4 py-3 text-sm leading-relaxed text-fg">{t('feynman.opener', { concept })}</p>
          </div>
          <div className="mt-6 space-y-6">
            {msgs.map((m) => (
              <MessageItem key={m.id} m={m} plain />
            ))}
          </div>
          {finishing && (
            <p className="mt-8 flex items-center justify-center gap-2 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" />
              {t('feynman.finishing')}
            </p>
          )}
          {report && conversationId && <Report r={report} conversationId={conversationId} onAgain={again} />}
        </div>
      </div>
      {!report && (
        <div className="shrink-0 px-8 pb-5">
          <div className="paper mx-auto max-w-[760px] rounded-2xl shadow-[var(--shadow-2)]">
            <Composer
              busy={!!streaming}
              placeholder={t('feynman.placeholder')}
              onSend={(text) => void send(text)}
              onStop={() => streaming && void api.chat.stop(streaming.id)}
            />
            <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2">
              <p className="text-2xs text-subtle">{t('feynman.tip')}</p>
              <Button size="sm" variant="outline" disabled={!replied || !!streaming || finishing} onClick={() => void finish()}>
                <Flag />
                {t('feynman.finish')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </FloatingPanel>
  )
}
