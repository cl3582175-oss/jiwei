import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog as D } from 'radix-ui'
import { toast } from 'sonner'
import {
  ChevronLeft,
  Sprout,
  CheckCircle2,
  Loader2,
  NotebookText,
  BookOpenText,
  Layers,
  CircleHelp,
  TrendingUp,
  TrendingDown,
  Sparkle,
  GraduationCap,
  ListTodo,
  MessageCircleQuestion,
  Target,
  Highlighter
} from 'lucide-react'
import { PROVIDER_PRESETS, type Effort } from '@shared/ai'
import type { InsightConfidence, ReflectionHarvest, ReflectionMaterial } from '@shared/types'
import { api, cn, formatDate } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { FloatingPanel } from '@/components/FloatingPanel'
import { NoteEditor } from '../notes/NoteEditor'
import { MessageItem } from '../chat/MessageItem'
import { Composer } from '../chat/ChatView'
import { errText, sendChat, useChatThread, useModelChoice } from '../chat/useChat'
import { ActionRow, CONF_TONE, ReflectHome, useReflectionEvents } from './ReflectHome'

// 复盘页：没有打开具体复盘时显示首页；打开后左侧是素材包 / AI 追问，右侧是复盘笔记（康奈尔：问题 + 回答）。

/* ——— 素材包 ——— */

function Section({ icon, title, count, children }: { icon: React.ReactNode; title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="border-b border-border/60 py-4 last:border-0">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted [&_svg]:size-3.5 [&_svg]:text-accent">
        {icon}
        {title}
        {count !== undefined && <span className="text-subtle">{count}</span>}
      </h3>
      <div className="mt-2 text-sm leading-relaxed text-fg">{children}</div>
    </section>
  )
}

function MaterialPane({ m }: { m: ReflectionMaterial }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const open = (id: string): void => useApp.getState().openNote(id)
  const empty =
    !m.mistakes.total && !m.goals.length && !m.notes.length && !m.episodes.length && !m.review.reviewed && !m.unanswered.length && !m.concepts.length && !m.feynman.length && !m.actions.length && !m.annotations.items.length
  if (empty) return <p className="py-8 text-center text-xs leading-relaxed text-subtle">{t('reflect.noMaterial')}</p>
  return (
    <div data-testid="material">
      {m.mistakes.total > 0 && <Section icon={<Layers />} title={t('learning.weekly')} count={m.mistakes.total}>
        <div data-testid="material-mistakes">
          <p>{t('learning.summary', { count: m.mistakes.total, verified: Math.round(m.mistakes.verifiedRatio * 100) })}</p>
          <p className="mt-1 text-xs text-muted">{m.mistakes.causes.filter((c) => c.count).map((c) => `${t(`learning.causes.${c.cause}`)} ${Math.round(c.percentage)}%`).join(' · ')}</p>
          <p className="mt-1 text-xs text-muted">{m.mistakes.concepts.map((c) => `${c.name} (${c.count})`).join(' · ')}</p>
        </div>
      </Section>}
      {m.goals.length > 0 && (
        <Section icon={<Target />} title={t('reflect.mGoals')} count={m.goals.length}>
          <ul className="space-y-2">
            {m.goals.map((g) => (
              <li key={g.id}>
                <div className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="min-w-0 truncate">{g.title}</span>
                  <span className="shrink-0 text-2xs text-subtle">
                    {t('goals.mastered', { pct: Math.round(g.mastered * 100) })}
                    {g.daysLeft !== null && ` · ${g.daysLeft >= 0 ? t('goals.daysLeft', { count: g.daysLeft }) : t('goals.overdue')}`}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(g.mastered * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {m.actions.length > 0 && (
        <Section icon={<ListTodo />} title={t('reflect.mActions')} count={m.actions.length}>
          <p className="mb-1.5 text-2xs text-subtle">{t('reflect.mActionsHint')}</p>
          <ul className="-mx-2">
            {m.actions.map((a) => (
              <ActionRow key={a.id} a={a} lang={i18n.language} onChange={() => void qc.invalidateQueries({ queryKey: ['reflection'] })} />
            ))}
          </ul>
        </Section>
      )}
      {m.notes.length > 0 && (
        <Section icon={<NotebookText />} title={t('reflect.mNotes')} count={m.notes.length}>
          <ul className="space-y-0.5">
            {m.notes.map((n) => (
              <li key={n.id}>
                <button onClick={() => open(n.id)} className="flex w-full items-center gap-2 text-left hover:text-accent">
                  <span className="min-w-0 flex-1 truncate">{n.title || t('common.untitled')}</span>
                  {n.created && <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] text-accent">{t('reflect.new')}</span>}
                  <span className="shrink-0 text-2xs text-subtle">{formatDate(n.editedAt, i18n.language)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {m.episodes.length > 0 && (
        <Section icon={<BookOpenText />} title={t('reflect.mEpisodes')} count={m.episodes.length}>
          <ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">
            {m.episodes.map((e, i) => (
              <li key={i}>{e.content}</li>
            ))}
          </ul>
        </Section>
      )}
      {m.review.reviewed > 0 && (
        <Section icon={<Layers />} title={t('reflect.mReview')}>
          <p>{t('reflect.mReviewStat', { count: m.review.reviewed, forgot: m.review.forgot })}</p>
          {m.review.hardest.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[13px] text-muted">
              {m.review.hardest.map((h, i) => (
                <li key={i}>
                  · {h.question} <span className="text-danger">×{h.lapses}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {m.unanswered.length > 0 && (
        <Section icon={<CircleHelp />} title={t('reflect.mUnanswered')} count={m.unanswered.length}>
          <ul className="space-y-0.5 text-[13px]">
            {m.unanswered.map((u, i) => (
              <li key={i}>
                <button onClick={() => open(u.noteId)} className="text-left hover:text-accent">
                  · {u.question} <span className="text-2xs text-subtle">《{u.noteTitle || t('common.untitled')}》</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {m.annotations.items.length > 0 && (
        <Section icon={<Highlighter />} title={t('reflect.mAnnotations', { count: m.annotations.highlights })} count={m.annotations.items.length}>
          <ul className="space-y-1 text-[13px]" data-testid="material-annotations">
            {m.annotations.items.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => {
                    const app = useApp.getState()
                    if (a.targetType === 'note') {
                      app.openNote(a.targetId)
                      if (a.ownerId) app.setHighlight({ type: 'block', id: a.ownerId })
                    } else {
                      app.openSource(a.targetId)
                      app.setHighlight({ type: 'segment', id: a.ownerId ?? '', locator: a.page ? `page=${a.page}` : null })
                    }
                  }}
                  className="text-left hover:text-accent"
                >
                  {a.question ? <span className="text-[#c0663a]">{t('reflect.mQuestionTag')}</span> : '· '}
                  {a.body || a.quote}
                  <span className="text-2xs text-subtle">
                    {' '}
                    《{a.targetTitle || t('common.untitled')}》{a.body && a.quote ? `“${a.quote.slice(0, 40)}${a.quote.length > 40 ? '…' : ''}”` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {m.concepts.length > 0 && (
        <Section icon={<TrendingUp />} title={t('reflect.mConcepts')} count={m.concepts.length}>
          <div className="flex flex-wrap gap-1.5">
            {m.concepts.map((c) => (
              <span key={c.name} className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-xs text-fg [&_svg]:size-3">
                {c.change === 'up' ? <TrendingUp className="text-accent" /> : c.change === 'down' ? <TrendingDown className="text-danger" /> : <Sparkle className="text-[#b8862b]" />}
                {c.name}
                <span className="text-subtle">{t(`memory.concept.${c.level}`)}</span>
              </span>
            ))}
          </div>
        </Section>
      )}
      {m.feynman.length > 0 && (
        <Section icon={<GraduationCap />} title={t('reflect.mFeynman')} count={m.feynman.length}>
          <ul className="space-y-0.5 text-[13px]">
            {m.feynman.map((f) => (
              <li key={f.conversationId}>
                · {f.concept} {f.level && <span className="text-subtle">（{t(`memory.concept.${f.level}`)}）</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

/* ——— AI 追问 ——— */

function CoachPane({ reflectionId }: { reflectionId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [conversationId, setConversationId] = useState<string | null>(null)
  const { choice, provider } = useModelChoice()
  const { msgs, setMsgs, streaming } = useChatThread(conversationId)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs])
  const send = async (text: string): Promise<void> => {
    if (streaming) return
    if (!choice.providerId || !choice.model) return void toast.error(t('chat.needModel'))
    const levels = provider ? PROVIDER_PRESETS[provider.kind].efforts : (['off'] as Effort[])
    try {
      const r = await sendChat({
        conversationId,
        text,
        providerId: choice.providerId,
        model: choice.model,
        effort: levels.includes('off') ? 'off' : levels[0],
        scope: { type: 'none' },
        kind: 'reflection',
        reflectionId
      })
      setMsgs((l) => [...l, r.userMessage, r.assistant])
      if (!conversationId) {
        qc.setQueryData(['messages', r.conversation.id], [r.userMessage, r.assistant])
        setConversationId(r.conversation.id)
      }
    } catch (e) {
      toast.error(errText(e))
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 space-y-5 overflow-y-auto py-4">
        <p className="text-xs leading-relaxed text-muted">{t('reflect.coachIntro')}</p>
        {msgs.length === 0 && (
          <Button size="sm" variant="outline" onClick={() => void send(t('reflect.coachStart'))}>
            <MessageCircleQuestion />
            {t('reflect.coachStartBtn')}
          </Button>
        )}
        {msgs.map((m) => (
          <MessageItem key={m.id} m={m} compact plain />
        ))}
      </div>
      <div className="shrink-0 pb-3">
        <div className="paper rounded-xl shadow-[var(--shadow-1)]">
          <Composer
            busy={!!streaming}
            placeholder={t('reflect.coachPh')}
            onSend={(text) => void send(text)}
            onStop={() => streaming && void api.chat.stop(streaming.id)}
          />
        </div>
      </div>
    </div>
  )
}

/* ——— 完成：确认洞见与行动项 ——— */

function HarvestDialog({ reflectionId, h, onClose }: { reflectionId: string; h: ReflectionHarvest; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [ins, setIns] = useState(h.insights.map((x) => ({ ...x, on: true })))
  const [revs, setRevs] = useState(h.revisions.map((x) => ({ ...x, on: true })))
  const [acts, setActs] = useState(h.actions.map((x) => ({ ...x, on: true })))
  const [saving, setSaving] = useState(false)
  const DAY = 86_400_000
  const commit = async (): Promise<void> => {
    setSaving(true)
    try {
      const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      await api.reflection.commit(reflectionId, {
        insights: ins.filter((x) => x.on && x.statement.trim()).map(({ statement, confidence, evidence }) => ({ statement: statement.trim(), confidence, evidence })),
        revisions: revs.filter((x) => x.on).map(({ insightId, statement, confidence, reason }) => ({ insightId, statement, confidence, reason })),
        actions: acts
          .filter((x) => x.on && x.title.trim())
          .map((a) => ({ title: a.title.trim(), dueAt: today + ((a.dueInDays ?? 7) + 1) * DAY - 1 }))
      })
      for (const k of ['reflection', 'insights', 'actions']) void qc.invalidateQueries({ queryKey: [k] })
      toast.success(t('reflect.committed'))
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSaving(false)
    }
  }
  const box = 'mt-1 accent-[var(--accent)]'
  const conf = (c: InsightConfidence, set: (c: InsightConfidence) => void) => (
    <div className="mt-1.5 flex gap-1">
      {(['hypothesis', 'believed', 'verified'] as const).map((k) => (
        <button key={k} onClick={() => set(k)} className={cn('rounded-full px-2 py-px text-2xs', c === k ? CONF_TONE[k] : 'text-subtle hover:bg-sunken')}>
          {t(`reflect.conf.${k}`)}
        </button>
      ))}
    </div>
  )
  const nothing = !h.insights.length && !h.revisions.length && !h.actions.length
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <D.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[84vh] w-[min(94vw,620px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-float outline-none"
          data-testid="harvest"
        >
          <D.Title className="font-serif text-lg font-semibold text-fg">{t('reflect.harvestTitle')}</D.Title>
          <D.Description className="mt-1 text-xs leading-relaxed text-muted">{t('reflect.harvestDesc')}</D.Description>
          {nothing && <p className="mt-6 text-sm text-muted">{t('reflect.harvestEmpty')}</p>}
          {ins.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-medium text-muted">{t('reflect.insights')}</h3>
              <ul className="mt-2 space-y-3">
                {ins.map((x, i) => (
                  <li key={i} className="flex gap-2.5">
                    <input type="checkbox" className={box} checked={x.on} onChange={(e) => setIns((l) => l.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)))} />
                    <div className="min-w-0 flex-1">
                      <textarea
                        value={x.statement}
                        rows={2}
                        aria-label={t('reflect.insights')}
                        onChange={(e) => setIns((l) => l.map((y, j) => (j === i ? { ...y, statement: e.target.value } : y)))}
                        className="block w-full resize-none rounded-lg border border-border bg-bg px-3 py-1.5 text-sm leading-relaxed text-fg outline-none focus:border-accent"
                      />
                      {conf(x.confidence, (c) => setIns((l) => l.map((y, j) => (j === i ? { ...y, confidence: c } : y))))}
                      {x.evidence && <p className="mt-1 text-2xs text-subtle">{t('reflect.evidence')}：{x.evidence}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {revs.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-medium text-muted">{t('reflect.revisions')}</h3>
              <ul className="mt-2 space-y-3">
                {revs.map((x, i) => (
                  <li key={i} className="flex gap-2.5">
                    <input type="checkbox" className={box} checked={x.on} onChange={(e) => setRevs((l) => l.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)))} />
                    <div className="min-w-0 flex-1 text-sm leading-relaxed">
                      <p className="text-subtle line-through">{x.current}</p>
                      <p className="text-fg">{x.statement}</p>
                      <p className="mt-0.5 text-2xs text-muted">{t('reflect.why')}：{x.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {acts.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-medium text-muted">{t('reflect.actions')}</h3>
              <ul className="mt-2 space-y-2">
                {acts.map((x, i) => (
                  <li key={i} className="flex items-center gap-2.5">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={x.on} onChange={(e) => setActs((l) => l.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)))} />
                    <input
                      value={x.title}
                      aria-label={t('reflect.actions')}
                      onChange={(e) => setActs((l) => l.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none focus:border-accent"
                    />
                    <span className="shrink-0 text-2xs text-subtle">{t('reflect.inDays', { count: x.dueInDays ?? 7 })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void commit()}>
              {saving && <Loader2 className="animate-spin" />}
              {t('reflect.commit')}
            </Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/* ——— 复盘会话 ——— */

function Session({ id }: { id: string }) {
  const { t } = useTranslation()
  const { data: r } = useQuery({ queryKey: ['reflection', id], queryFn: () => api.reflection.get(id) })
  const { data: m } = useQuery({ queryKey: ['reflection', id, 'material'], queryFn: () => api.reflection.material(id) })
  const [tab, setTab] = useState<'material' | 'coach'>('material')
  const [harvest, setHarvest] = useState<ReflectionHarvest | null>(null)
  const [busy, setBusy] = useState(false)
  if (!r) return null
  const finish = async (): Promise<void> => {
    setBusy(true)
    try {
      setHarvest(await api.reflection.harvest(id))
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-6 py-2.5">
        <h2 className="min-w-0 flex-1 truncate font-serif text-md font-semibold text-fg">{r.title}</h2>
        <span className={cn('rounded-full px-2 py-0.5 text-2xs', r.status === 'done' ? 'bg-accent-soft text-accent' : 'bg-sunken text-muted')}>
          {t(`reflect.status.${r.status}`)}
        </span>
        {r.kind !== 'daily' && (
          <Button size="sm" variant={r.status === 'done' ? 'outline' : 'primary'} disabled={busy} onClick={() => void finish()}>
            {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            {busy ? t('reflect.harvesting') : r.status === 'done' ? t('reflect.harvestAgain') : t('reflect.finish')}
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,38.2%)_1fr]">
        <aside className="flex min-h-0 flex-col border-r border-border/60 px-5">
          <div role="tablist" className="mt-3 inline-flex self-start rounded-lg bg-sunken p-0.5">
            {(['material', 'coach'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn('rounded-md px-3 py-1 text-xs transition-colors', tab === k ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}
              >
                {t(`reflect.tab.${k}`)}
              </button>
            ))}
          </div>
          <div className={cn('min-h-0 flex-1', tab === 'material' ? 'overflow-y-auto' : 'hidden')}>{m && <MaterialPane m={m} />}</div>
          <div className={cn('min-h-0 flex-1', tab === 'coach' ? '' : 'hidden')}>
            <CoachPane reflectionId={id} />
          </div>
        </aside>
        <div className="min-h-0 overflow-hidden">{r.noteId && <NoteEditor noteId={r.noteId} />}</div>
      </div>
      {harvest && <HarvestDialog reflectionId={id} h={harvest} onClose={() => setHarvest(null)} />}
    </div>
  )
}

export function ReflectView() {
  const { t } = useTranslation()
  useReflectionEvents()
  const id = useApp((s) => s.reflectionId)
  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-4">
        {id && (
          <Button size="icon-sm" variant="ghost" className="no-drag" aria-label={t('reflect.backHome')} onClick={() => useApp.getState().openReflection(null)}>
            <ChevronLeft />
          </Button>
        )}
        <Sprout className="size-4 text-accent" />
        <span className="font-serif text-md font-semibold tracking-wide text-fg">{t('reflect.title')}</span>
      </header>
      <div className={cn('min-h-0 flex-1', id ? 'overflow-hidden' : 'overflow-y-auto')}>{id ? <Session key={id} id={id} /> : <ReflectHome />}</div>
    </FloatingPanel>
  )
}
