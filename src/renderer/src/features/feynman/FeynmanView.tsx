import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronLeft, GraduationCap, Loader2, CheckCircle2, CircleHelp, CircleAlert, NotebookPen, RotateCcw, Flag, ArrowRight, History } from 'lucide-react'
import { PROVIDER_PRESETS, type Effort } from '@shared/ai'
import type { FeynmanReport } from '@shared/types'
import { api, cn, formatRelative } from '@/lib/utils'
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

/** 首页（v0.7.6）：从导航进入、还没有正在进行的练习时——挑概念开始，或回看练过的 */
function FeynmanHomePage() {
  const { t, i18n } = useTranslation()
  const [concept, setConcept] = useState('')
  const { data } = useQuery({ queryKey: ['feynman', 'home'], queryFn: () => api.feynman.home() })
  const start = (c: string, noteId: string | null = null, cardId: string | null = null): void => {
    if (c.trim()) useApp.getState().startFeynman({ concept: c.trim(), noteId, cardId })
  }
  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <GraduationCap className="size-4 text-accent" />
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('feynman.title')}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="feynman-home">
        <div className="mx-auto max-w-[720px] px-8 pt-12 pb-16">
          <div className="text-center">
            <span className="mx-auto grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
              <GraduationCap className="size-6" />
            </span>
            <h2 className="mt-4 font-serif text-xl font-semibold text-fg">{t('feynman.home.heading')}</h2>
            <p className="mx-auto mt-2 max-w-[500px] text-sm leading-relaxed text-muted">{t('feynman.home.sub')}</p>
          </div>
          <form
            className="paper mx-auto mt-7 flex max-w-[560px] items-center gap-2 rounded-2xl py-1.5 pr-1.5 pl-4 shadow-[var(--shadow-2)]"
            onSubmit={(e) => {
              e.preventDefault()
              start(concept)
            }}
          >
            <input
              autoFocus
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              placeholder={t('feynman.home.input')}
              aria-label={t('feynman.home.input')}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
            />
            <Button type="submit" variant="primary" size="sm" disabled={!concept.trim()}>
              {t('feynman.home.start')}
              <ArrowRight />
            </Button>
          </form>
          {!!data?.suggestions.length && (
            <section className="mt-8">
              <h3 className="text-xs font-medium text-muted">{t('feynman.home.suggest')}</h3>
              <div className="mt-2.5 flex flex-wrap gap-2" data-testid="feynman-suggestions">
                {data.suggestions.map((sg) => (
                  <button
                    key={sg.concept}
                    onClick={() => start(sg.concept, sg.noteId, sg.cardId)}
                    className="group inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-left text-sm text-fg transition-colors hover:border-accent/50 hover:bg-accent-soft/40"
                  >
                    <span className="truncate">{sg.concept}</span>
                    <span className="shrink-0 text-2xs text-subtle group-hover:text-accent">{t(`feynman.home.reason.${sg.reason}`)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="mt-9">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <History className="size-3.5" />
              {t('feynman.home.history')}
            </h3>
            {data && !data.sessions.length ? (
              <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted">{t('feynman.home.historyEmpty')}</p>
            ) : (
              <ul className="mt-2 divide-y divide-border/60" data-testid="feynman-history">
                {data?.sessions.map((x) => (
                  <li key={x.id}>
                    <button
                      onClick={() => useApp.getState().startFeynman({ concept: x.concept, noteId: x.noteId, conversationId: x.id })}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface-hover"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{x.concept}</span>
                      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-2xs', x.level ? LEVEL_TONE[x.level] : 'bg-sunken text-subtle')}>
                        {x.level ? t(`memory.concept.${x.level}`) : t('feynman.home.unfinished')}
                      </span>
                      <span className="w-20 shrink-0 text-right text-2xs text-subtle">{formatRelative(x.updatedAt, i18n.language)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </FloatingPanel>
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

  if (!session) return <FeynmanHomePage />
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
        <Button size="icon-sm" variant="ghost" className="no-drag" aria-label={t('feynman.home.all')} onClick={() => useApp.getState().closeFeynman()}>
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
