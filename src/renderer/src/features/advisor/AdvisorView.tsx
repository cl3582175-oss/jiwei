import { PluginSourceLabel, usePluginNames } from '../plugins/PluginSourceLabel'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CalendarCheck,
  Check,
  ChevronDown,
  FileText,
  HelpCircle,
  Lightbulb,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Scale,
  ShieldAlert,
  Skull,
  Sparkles,
  Swords,
  Trash2,
  Waypoints,
  Square
} from 'lucide-react'
import { matrixTotals, type Decision, type DecisionMemo } from '@shared/advisor'
import { estimateCost } from '@shared/ai'
import { FloatingPanel } from '@/components/FloatingPanel'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { api, cn } from '@/lib/utils'
import { useSettings } from '@/lib/queries'
import { useMoney } from '@/lib/money'
import { useApp } from '@/store/app'
import { PlanDialog, Segmented, field } from '@/features/plan/ui'
import { setAdvisorDraft, useAdvisorGeneration, useAdvisorState } from './generation'

// 参谋与决策日志（v0.9）：提问 → 备忘录（选项、决策矩阵、依据、假设、事前验尸、反方意见）→ 记录决定与预期 → 到期回看。

const DAY = 86400000
/** 悬停提示是纯文本，去掉引用编号 */
const plain = (s: string): string => s.replace(/\s*[（(]\s*S\d{1,2}(?:\s*[、,，]\s*S\d{1,2})*\s*[）)]/g, '')
const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function useDecisionEvents(): void {
  const qc = useQueryClient()
  useEffect(() => window.jiweiEvents.on('advisor:changed', () => void qc.invalidateQueries({ queryKey: ['advisor'] })), [qc])
}

export function AdvisorView() {
  const { t } = useTranslation()
  const [openId, setOpenId] = useState<string | null>(() => useApp.getState().decisionId ?? null)
  useDecisionEvents()
  useEffect(() => useApp.subscribe((s) => s.decisionId !== undefined && setOpenId(s.decisionId ?? null)), [])
  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('advisor.title')}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="advisor-view">
        <div className="mx-auto max-w-[920px] px-10 pt-8 pb-16">
          {openId ? (
            <DecisionPage id={openId} onBack={() => useApp.setState({ decisionId: null })} />
          ) : (
            <Home onOpen={(id) => useApp.setState({ decisionId: id })} />
          )}
        </div>
      </div>
    </FloatingPanel>
  )
}

/* ——— 首页：提问 + 决策日志 ——— */

function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation()
  const { data: settings } = useSettings()
  const money = useMoney()
  const { data: list = [] } = useQuery({ queryKey: ['advisor', 'list'], queryFn: () => api.advisor.list() })
  const { data: goals = [] } = useQuery({ queryKey: ['goals'], queryFn: () => api.goals.list() })
  const { data: frameworks = [] } = useQuery({ queryKey: ['frameworks'], queryFn: () => api.plugins.frameworks() })
  const pluginName = usePluginNames()
  const { frameworkId, question, context, showContext, goalId } = useAdvisorState((s) => s.draft)
  const setFrameworkId = (frameworkId: string) => setAdvisorDraft({ frameworkId })
  const setQuestion = (question: string) => setAdvisorDraft({ question })
  const setContext = (context: string) => setAdvisorDraft({ context })
  const setShowContext = (showContext: boolean) => setAdvisorDraft({ showContext })
  const setGoalId = (goalId: string) => setAdvisorDraft({ goalId })
  const { busy, stopped, run, stop } = useAdvisorGeneration('ask')
  const selected = frameworks.find((x) => x.id === frameworkId)
  // 角色起步卡：选好分析框架、预填问题，不自动提交
  useEffect(() => {
    const intent = useApp.getState().takeStarterIntent('advisor')
    if (!intent) return
    setFrameworkId(intent.framework)
    setQuestion(intent.question)
  }, [])
  const model = settings?.ai.chat.model ?? null
  // 一次备忘录：约 7k 输入（问题 + 10 段依据）、2.5k 输出
  const cost = model
    ? estimateCost(
        model,
        { inputTokens: 7000, outputTokens: 2500, reasoningTokens: 0, cachedInputTokens: 0 },
        Date.now(),
        null,
        settings?.money
      )
    : null
  const submit = async (): Promise<void> => {
    if (question.trim().length < 4 || busy) return
    await run(
      () =>
        api.advisor.ask({
          question: question.trim(),
          context: context.trim(),
          goalId: goalId || null,
          frameworkId: frameworkId || undefined
        }),
      (d) => {
        setAdvisorDraft({ question: '', context: '' })
        onOpen(d.id)
      }
    )
  }

  const now = Date.now()
  const groups: { key: string; items: Decision[] }[] = [
    { key: 'due', items: list.filter((d) => d.status === 'decided' && d.reviewAt !== null && d.reviewAt <= now) },
    { key: 'open', items: list.filter((d) => d.status === 'draft' || (d.status === 'decided' && (d.reviewAt ?? Infinity) > now)) },
    { key: 'reviewed', items: list.filter((d) => d.status === 'reviewed') },
    { key: 'dropped', items: list.filter((d) => d.status === 'dropped') }
  ]
  return (
    <div className="space-y-10">
      <section>
        <p className="max-w-[680px] text-sm leading-relaxed text-muted">{t('advisor.intro')}</p>
        <div className="mt-5 rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-1)] focus-within:border-accent/60">
          <textarea
            aria-label={t('advisor.title')}
            className="block min-h-[64px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-fg outline-none placeholder:text-subtle"
            placeholder={t('advisor.questionPh')}
            value={question}
            disabled={busy}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
          <label className="mt-3 block text-xs text-muted">
            {t('plugins.framework')}
            <select
              aria-label={t('plugins.framework')}
              className={field}
              value={frameworkId}
              disabled={busy}
              onChange={(e) => setFrameworkId(e.target.value)}
            >
              <option value="">{t('plugins.none')}</option>
              {frameworks.map((x) => (
                <option key={x.id} value={x.id}>
                  {i18n.language.startsWith('zh') ? x.title.zh : x.title.en}
                  {x.pluginId ? ` · ${pluginName(x.pluginId)}` : ''}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <div className="mt-2 space-y-1 text-xs text-muted">
              <PluginSourceLabel pluginId={selected.pluginId} />
              <p>{i18n.language.startsWith('zh') ? selected.description.zh : selected.description.en}</p>
              <ul>
                {selected.criteria.map((c, i) => (
                  <li key={i}>
                    {c.name} · {c.weight} · {c.hint}
                  </li>
                ))}
              </ul>
              <ul>
                {selected.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {showContext && (
            <textarea
              aria-label={t('advisor.context')}
              className={cn(field, 'min-h-[72px] resize-y')}
              placeholder={t('advisor.contextPh')}
              value={context}
              disabled={busy}
              onChange={(e) => setContext(e.target.value)}
            />
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!showContext && (
              <Button size="sm" variant="ghost" onClick={() => setShowContext(true)}>
                {t('advisor.context')}
              </Button>
            )}
            {goals.length > 0 && (
              <select
                aria-label={t('advisor.direction')}
                className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-fg"
                value={goalId}
                onChange={(e) => setGoalId(e.target.value)}
              >
                <option value="">
                  {t('advisor.direction')} · {t('advisor.noDirection')}
                </option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            )}
            <span className="ml-auto text-2xs text-subtle">
              {model ? t('advisor.costHint', { model, cost: cost === null ? '—' : money.format(cost) }) : t('advisor.noModel')}
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || question.trim().length < 4 || !model || (!!frameworkId && !selected)}
              onClick={() => void submit()}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Scale />}
              {t('advisor.ask')}
            </Button>
          </div>
          {busy && (
            <p role="status" className="mt-3 flex items-center gap-2 text-xs text-accent">
              <Sparkles className="size-3.5 animate-pulse" />
              {t('advisor.asking')}
              <span className="text-subtle">{t('advisor.askingHint')}</span>
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void stop()}>
                <Square className="fill-current" />
                {t('advisor.stop')}
              </Button>
            </p>
          )}
        </div>
        {stopped && (
          <p role="status" className="mt-3 text-xs text-muted">
            {t('advisor.stopped')}
          </p>
        )}
        {!list.length && !busy && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">{t('advisor.examples')}</span>
            {['example1', 'example2', 'example3'].map((k) => (
              <button
                key={k}
                className="rounded-full border border-border px-3 py-1 text-xs text-fg transition-colors hover:border-accent/50 hover:bg-surface-hover"
                onClick={() => setQuestion(t(`advisor.${k}`))}
              >
                {t(`advisor.${k}`)}
              </button>
            ))}
          </div>
        )}
      </section>

      <section data-testid="decision-log">
        <h2 className="text-sm font-semibold text-fg">{t('advisor.log')}</h2>
        {!list.length ? (
          <p className="mt-3 rounded-2xl border border-dashed border-border-strong px-5 py-6 text-sm text-muted">{t('advisor.logEmpty')}</p>
        ) : (
          groups
            .filter((g) => g.items.length)
            .map((g) => (
              <div key={g.key} className="mt-4">
                <p className={cn('mb-2 text-2xs font-medium tracking-wide', g.key === 'due' ? 'text-warning' : 'text-subtle')}>
                  {t(`advisor.${g.key}`)} · {g.items.length}
                </p>
                <ul className="paper divide-y divide-border/70 overflow-hidden rounded-2xl shadow-[var(--shadow-1)]">
                  {g.items.map((d) => (
                    <li key={d.id} className="group/decision">
                      <div className="flex items-center pr-2">
                        <button
                          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover/60"
                          onClick={() => onOpen(d.id)}
                          data-decision={d.question}
                        >
                          <StatusDot d={d} now={now} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-fg">{d.question}</span>
                            {d.choice && <span className="mt-0.5 block truncate text-xs text-muted">→ {d.choice}</span>}
                          </span>
                          {d.status === 'decided' && d.reviewAt && (
                            <span className={cn('shrink-0 text-2xs tabular-nums', d.reviewAt <= now ? 'text-warning' : 'text-subtle')}>
                              {d.reviewAt <= now
                                ? t('advisor.overdue')
                                : t('advisor.reviewOn', { date: new Date(d.reviewAt).toLocaleDateString(i18n.language) })}
                            </span>
                          )}
                          {d.status === 'reviewed' && d.accuracy && <Accuracy n={d.accuracy} />}
                        </button>
                        <DecisionActions d={d} onRemoved={() => {}} home />
                      </div>
                      <div className="px-4 pb-2">
                        <PluginSourceLabel pluginId={d.framework?.pluginId} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
        )}
      </section>
    </div>
  )
}

function DecisionActions({
  d,
  onRemoved,
  onRegenerate,
  busy = false,
  home = false
}: {
  d: Decision
  onRemoved: () => void
  onRegenerate?: () => void
  busy?: boolean
  home?: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const change = async (fn: () => Promise<unknown>, removed = false): Promise<void> => {
    try {
      await fn()
      void qc.invalidateQueries({ queryKey: ['advisor'] })
      if (removed) onRemoved()
    } catch (error) {
      toast.error(errText(error))
    }
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('common.more')}
          onClick={(e) => e.stopPropagation()}
          className={
            home
              ? 'opacity-0 group-hover/decision:opacity-100 group-focus-within/decision:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 max-[1100px]:opacity-100'
              : undefined
          }
        >
          <MoreHorizontal />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        {onRegenerate && d.status !== 'reviewed' && (
          <MenuItem disabled={busy} onSelect={onRegenerate}>
            <RotateCcw />
            {t('advisor.regenerate')}
          </MenuItem>
        )}
        {d.status === 'dropped' && (
          <MenuItem onSelect={() => void change(() => api.advisor.status(d.id, 'draft'))}>{t('advisor.restore')}</MenuItem>
        )}
        {d.status === 'draft' && (
          <MenuItem onSelect={() => void change(() => api.advisor.status(d.id, 'dropped'))}>{t('advisor.drop')}</MenuItem>
        )}
        <MenuItem
          danger
          onSelect={() =>
            void (async () => {
              if (await confirm({ title: t('advisor.removeTitle'), description: t('advisor.removeDesc'), danger: true }))
                await change(() => api.advisor.remove(d.id), true)
            })()
          }
        >
          <Trash2 />
          {t('advisor.remove')}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function StatusDot({ d, now }: { d: Decision; now: number }) {
  const cls =
    d.status === 'decided' && d.reviewAt && d.reviewAt <= now
      ? 'bg-warning'
      : d.status === 'decided'
        ? 'bg-accent'
        : d.status === 'reviewed'
          ? 'bg-[var(--p-bamboo-ink)]'
          : 'border border-border-strong bg-transparent'
  return <span className={cn('size-2 shrink-0 rounded-full', cls)} aria-hidden />
}

function Accuracy({ n }: { n: number }) {
  const { t } = useTranslation()
  return (
    <span className="flex shrink-0 items-center gap-0.5" title={t(`advisor.acc.${n}`)} aria-label={`${t('advisor.accuracy')} ${n}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={cn('h-1.5 w-3 rounded-full', i <= n ? 'bg-accent' : 'bg-sunken')} />
      ))}
    </span>
  )
}

/* ——— 备忘录页 ——— */

function DecisionPage({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const { data: d } = useQuery({ queryKey: ['advisor', 'one', id], queryFn: () => api.advisor.get(id) })
  const { busy, stopped, run, stop } = useAdvisorGeneration(id)
  const [deciding, setDeciding] = useState(false),
    [reviewing, setReviewing] = useState(false)
  if (!d) return null
  const memo = d.memo
  return (
    <div className="space-y-8" data-testid="decision-page">
      <div>
        <button className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          {t('advisor.back')}
        </button>
        <div className="mt-3 flex items-start gap-4">
          <h2 className="min-w-0 flex-1 font-serif text-2xl leading-snug font-semibold text-fg">{d.question}</h2>
          <div className="flex shrink-0 items-center gap-1.5">
            {d.status === 'draft' && memo && (
              <Button variant="primary" size="sm" onClick={() => setDeciding(true)}>
                <Check />
                {t('advisor.decide')}
              </Button>
            )}
            {d.status === 'decided' && (
              <Button variant="primary" size="sm" onClick={() => setReviewing(true)}>
                <CalendarCheck />
                {t('advisor.reviewNow')}
              </Button>
            )}
            <DecisionActions d={d} onRemoved={onBack} onRegenerate={() => void run(() => api.advisor.regenerate(id))} busy={busy} />
          </div>
        </div>
        {d.context && <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted">{d.context}</p>}
        {busy && (
          <p role="status" className="mt-3 flex items-center gap-2 text-xs text-accent">
            <Loader2 className="size-3.5 animate-spin" />
            {t('advisor.asking')}
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => void stop()}>
              <Square className="fill-current" />
              {t('advisor.stop')}
            </Button>
          </p>
        )}
      </div>

      {stopped && (
        <p role="status" className="text-xs text-muted">
          {t('advisor.stopped')}
        </p>
      )}
      {/* 决定与回看 */}
      {(d.status === 'decided' || d.status === 'reviewed') && (
        <section className="rounded-2xl border border-accent/25 bg-accent-soft/40 px-5 py-4" data-testid="decision-record">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('advisor.decided')}>{d.choice}</Field>
            <Field label={t('advisor.expected')}>{d.expectation}</Field>
          </div>
          {d.status === 'decided' && d.reviewAt && (
            <p className="mt-3 text-xs text-muted">
              {t('advisor.reviewOn', { date: new Date(d.reviewAt).toLocaleDateString(i18n.language) })}
            </p>
          )}
          {d.status === 'reviewed' && (
            <div className="mt-4 grid gap-4 border-t border-accent/20 pt-4 sm:grid-cols-2">
              <Field label={t('advisor.outcome')}>{d.outcome}</Field>
              <div>
                <p className="text-2xs font-medium tracking-wide text-subtle">{t('advisor.accuracy')}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  {d.accuracy && <Accuracy n={d.accuracy} />}
                  <span className="text-sm text-fg">{d.accuracy && t(`advisor.acc.${d.accuracy}`)}</span>
                </div>
                {d.lesson && <p className="mt-3 text-sm leading-relaxed text-fg">💡 {d.lesson}</p>}
              </div>
            </div>
          )}
        </section>
      )}

      {memo ? <Memo d={d} memo={memo} /> : !busy && <Regenerate onClick={() => void run(() => api.advisor.regenerate(id))} />}

      {deciding && memo && <DecideDialog d={d} memo={memo} onClose={() => setDeciding(false)} />}
      {reviewing && <ReviewDialog d={d} onClose={() => setReviewing(false)} />}
    </div>
  )
}

function Regenerate({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-2xl border border-dashed border-border-strong px-5 py-6 text-center">
      <Button variant="outline" size="sm" onClick={onClick}>
        <RotateCcw />
        {t('advisor.regenerate')}
      </Button>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-2xs font-medium tracking-wide text-subtle">{label}</p>
      <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">{children}</p>
    </div>
  )
}

function Block({
  icon,
  title,
  hint,
  children,
  tone
}: {
  icon: ReactNode
  title: string
  hint?: string
  children: ReactNode
  tone?: 'warn'
}) {
  return (
    <section className="paper rounded-2xl px-5 py-4 shadow-[var(--shadow-1)]">
      <h3 className={cn('flex items-center gap-2 text-sm font-semibold', tone === 'warn' ? 'text-warning' : 'text-fg')}>
        <span className="[&_svg]:size-4">{icon}</span>
        {title}
      </h3>
      {hint && <p className="mt-0.5 text-2xs text-subtle">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

const Bullets = ({ items, cite }: { items: string[]; cite: (text: string) => ReactNode }) => (
  <ul className="space-y-1.5 text-sm leading-relaxed text-fg">
    {items.map((x, i) => (
      <li key={i} className="flex gap-2">
        <span className="mt-2 size-1 shrink-0 rounded-full bg-subtle" />
        <span className="min-w-0">{cite(x)}</span>
      </li>
    ))}
  </ul>
)

function Memo({ d, memo }: { d: Decision; memo: DecisionMemo }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [weights, setWeights] = useState<Record<string, number> | null>(d.weights)
  useEffect(() => setWeights(d.weights), [d.weights])
  const totals = useMemo(() => matrixTotals(memo, weights), [memo, weights])
  const best = Math.max(...Object.values(totals))
  const w = (name: string, fallback: number): number => weights?.[name] ?? fallback
  const saveWeights = (next: Record<string, number> | null): void => {
    setWeights(next)
    void api.advisor
      .weights(d.id, next)
      .then(() => qc.invalidateQueries({ queryKey: ['advisor', 'one', d.id] }))
      .catch((e) => toast.error(errText(e)))
  }
  const sourceOf = (sid: string) => memo.sources.find((s) => s.id === sid)
  const open = (sid: string): void => {
    const s = sourceOf(sid)
    if (!s || s.available === false) return
    if (s.parentType === 'note') useApp.getState().openNote(s.parentId)
    else useApp.getState().openSource(s.parentId)
  }
  // 正文里的“（S1、S3）”渲染成可点的出处标签，不把内部编号直接给用户看
  const cite = (text: string): ReactNode => {
    const parts = text.split(/\s*[（(]\s*(S\d{1,2}(?:\s*[、,，]\s*S\d{1,2})*)\s*[）)]/g)
    return parts.map((part, i) =>
      i % 2 === 0 ? (
        part
      ) : (
        <span key={i} className="mx-0.5 inline-flex gap-0.5 align-super">
          {part.split(/\s*[、,，]\s*/).map((sid) => {
            const src = sourceOf(sid)
            const n = memo.sources.findIndex((x) => x.id === sid) + 1
            return src ? (
              <button
                key={sid}
                className="rounded bg-accent-soft px-1 text-[10px] leading-4 text-accent hover:bg-accent-soft/70"
                title={src.title}
                onClick={() => open(sid)}
              >
                {n}
              </button>
            ) : null
          })}
        </span>
      )
    )
  }
  return (
    <div className="space-y-6" data-testid="decision-memo">
      <p className="rounded-xl bg-sunken/60 px-4 py-3 text-sm leading-relaxed text-muted">
        <span className="mr-2 text-2xs font-medium tracking-wide text-subtle">{t('advisor.restated')}</span>
        {memo.restated}
      </p>

      {/* 选项 */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-fg">{t('advisor.options')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {memo.options.map((o) => {
            const rec = memo.recommendation.option === o.id
            return (
              <div
                key={o.id}
                className={cn(
                  'rounded-2xl border p-4 transition-colors',
                  rec ? 'border-accent/50 bg-accent-soft/30' : 'border-border bg-surface'
                )}
                data-option={o.id}
              >
                <div className="flex items-center gap-2">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-2xs font-semibold text-muted">
                    {o.id.slice(1)}
                  </span>
                  <p className="min-w-0 flex-1 text-sm font-semibold text-fg">{o.title}</p>
                  <span className={cn('shrink-0 font-serif text-lg tabular-nums', totals[o.id] === best ? 'text-accent' : 'text-subtle')}>
                    {totals[o.id]}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted">{o.summary}</p>
                {rec && (
                  <p className="mt-3 flex gap-1.5 border-t border-accent/20 pt-3 text-xs leading-relaxed text-fg">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
                    <span>
                      <span className="font-medium text-accent">{t('advisor.recommended')}</span>：{cite(memo.recommendation.why)}
                      <span className="ml-1 text-subtle">· {t('advisor.confidence', { n: memo.confidence })}</span>
                    </span>
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* 决策矩阵 */}
      <section className="paper overflow-hidden rounded-2xl shadow-[var(--shadow-1)]" data-testid="decision-matrix">
        <div className="flex items-center gap-3 px-5 pt-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Waypoints className="size-4" />
            {t('advisor.matrix')}
          </h3>
          <span className="text-2xs text-subtle">{t('advisor.matrixHint')}</span>
          {weights && (
            <button className="ml-auto text-2xs text-muted hover:text-accent" onClick={() => saveWeights(null)}>
              {t('advisor.resetWeights')}
            </button>
          )}
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-y border-border/70 text-2xs text-subtle">
                <th className="min-w-[10rem] px-5 py-2 text-left font-medium">{t('advisor.criterion')}</th>
                <th className="w-28 px-2 py-2 text-left font-medium">{t('advisor.weight')}</th>
                {memo.options.map((o) => (
                  <th key={o.id} className="px-2 py-2 text-center font-medium" title={o.title}>
                    {o.id.slice(1)} · <span className="inline-block max-w-[6.5rem] truncate align-bottom">{o.title}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {memo.criteria.map((c) => (
                <tr key={c.name} className="border-b border-border/50">
                  <td className="min-w-[10rem] px-5 py-2.5 leading-snug text-fg" title={plain(c.why)}>
                    {c.name}
                  </td>
                  <td className="px-2 py-2">
                    <WeightStepper
                      label={c.name}
                      value={w(c.name, c.weight)}
                      onChange={(v) =>
                        saveWeights({ ...Object.fromEntries(memo.criteria.map((x) => [x.name, w(x.name, x.weight)])), [c.name]: v })
                      }
                    />
                  </td>
                  {memo.options.map((o) => {
                    const s = memo.scores.find((x) => x.option === o.id && x.criterion === c.name)
                    return (
                      <td key={o.id} className="px-2 py-2 text-center" title={plain(s?.why ?? '')}>
                        <ScoreDots n={s?.score ?? 0} />
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr>
                <td className="px-5 py-3 text-xs font-medium text-muted" colSpan={2}>
                  {t('advisor.total')}
                </td>
                {memo.options.map((o) => (
                  <td key={o.id} className="px-2 py-3">
                    <div className="mx-auto h-1.5 w-16 overflow-hidden rounded-full bg-sunken">
                      <div
                        className={cn(
                          'h-full rounded-full transition-[width] duration-300',
                          totals[o.id] === best ? 'bg-accent' : 'bg-subtle/60'
                        )}
                        style={{ width: `${totals[o.id]}%` }}
                      />
                    </div>
                    <p className="mt-1 text-center text-xs text-fg tabular-nums">{totals[o.id]}</p>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* 依据 */}
      <Block icon={<BookOpen />} title={t('advisor.evidence')}>
        {memo.evidence.length ? (
          <ul className="space-y-2.5" data-testid="decision-evidence">
            {memo.evidence.map((e, i) => {
              const s = sourceOf(e.source)
              const off = !s || s.available === false
              return (
                <li key={i} className="flex gap-3 text-sm leading-relaxed">
                  <button
                    className={cn(
                      'mt-0.5 flex h-6 max-w-[14rem] shrink-0 items-center gap-1 rounded-md px-2 text-2xs',
                      off ? 'cursor-default bg-sunken text-subtle line-through' : 'bg-accent-soft text-accent hover:bg-accent-soft/80'
                    )}
                    title={off ? t('advisor.unavailable') : s?.text}
                    onClick={() => open(e.source)}
                  >
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">{s?.title ?? e.source}</span>
                  </button>
                  <span className="min-w-0 text-fg">{cite(e.claim)}</span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t('advisor.evidenceEmpty')}</p>
        )}
      </Block>

      <div className="grid gap-4 md:grid-cols-2">
        {memo.assumptions.length > 0 && (
          <Block icon={<Lightbulb />} title={t('advisor.assumptions')}>
            <Bullets items={memo.assumptions} cite={cite} />
          </Block>
        )}
        {memo.premortem.length > 0 && (
          <Block icon={<Skull />} title={t('advisor.premortem')} hint={t('advisor.premortemHint')}>
            <Bullets items={memo.premortem} cite={cite} />
          </Block>
        )}
        {memo.secondOrder.length > 0 && (
          <Block icon={<Waypoints />} title={t('advisor.secondOrder')}>
            <Bullets items={memo.secondOrder} cite={cite} />
          </Block>
        )}
        {memo.risks.length > 0 && (
          <Block icon={<ShieldAlert />} title={t('advisor.risks')}>
            <ul className="space-y-2 text-sm leading-relaxed">
              {memo.risks.map((r, i) => (
                <li key={i}>
                  <p className="text-fg">{cite(r.risk)}</p>
                  {r.mitigation && <p className="mt-0.5 text-xs text-muted">↳ {cite(r.mitigation)}</p>}
                </li>
              ))}
            </ul>
          </Block>
        )}
      </div>
      {memo.counter && (
        <Block icon={<Swords />} title={t('advisor.counter')} tone="warn">
          <p className="text-sm leading-relaxed text-fg">{cite(memo.counter)}</p>
        </Block>
      )}
      {memo.unknowns.length > 0 && (
        <Block icon={<HelpCircle />} title={t('advisor.unknowns')}>
          <Bullets items={memo.unknowns} cite={cite} />
        </Block>
      )}
    </div>
  )
}

function ScoreDots({ n }: { n: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${n}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={cn('size-1.5 rounded-full', i <= n ? 'bg-accent' : 'bg-sunken')} />
      ))}
    </span>
  )
}

function WeightStepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border" role="group" aria-label={label}>
      <button
        className="grid size-6 place-items-center text-muted hover:text-fg disabled:opacity-30"
        aria-label="−"
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="w-5 text-center text-xs text-fg tabular-nums" data-testid="weight-value">
        {value}
      </span>
      <button
        className="grid size-6 place-items-center text-muted hover:text-fg disabled:opacity-30"
        aria-label="+"
        disabled={value >= 5}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </span>
  )
}

/* ——— 记录决定 ——— */

export function DecideDialog({ d, memo, onClose, initialPick }: { d: Decision; memo: DecisionMemo; onClose: () => void; initialPick?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [pick, setPick] = useState<string>(initialPick ?? memo.recommendation.option),
    [custom, setCustom] = useState(''),
    [expectation, setExpectation] = useState(''),
    [days, setDays] = useState<'14' | '30' | '90'>('30'),
    [busy, setBusy] = useState(false)
  const choice = pick === 'custom' ? custom.trim() : (memo.options.find((o) => o.id === pick)?.title ?? '')
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.advisor.decide({ id: d.id, choice, expectation: expectation.trim(), reviewAt: Date.now() + Number(days) * DAY })
      void qc.invalidateQueries({ queryKey: ['advisor'] })
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <PlanDialog
      title={t('advisor.decideTitle')}
      description={t('advisor.decideHint')}
      onClose={onClose}
      testId="decide-dialog"
      footer={
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !choice || !expectation.trim()} onClick={() => void save()}>
            {t('advisor.save')}
          </Button>
        </div>
      }
    >
      <fieldset>
        <legend className="text-xs text-muted">{t('advisor.choice')}</legend>
        <div className="mt-2 space-y-1.5" role="radiogroup">
          {[...memo.options.map((o) => ({ id: o.id, label: o.title })), { id: 'custom', label: t('advisor.custom') }].map((o) => (
            <label
              key={o.id}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                pick === o.id ? 'border-accent bg-accent-soft/30 text-fg' : 'border-border text-fg hover:bg-surface-hover'
              )}
            >
              <input type="radio" name="choice" className="accent-[var(--accent)]" checked={pick === o.id} onChange={() => setPick(o.id)} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.id === memo.recommendation.option && <span className="text-2xs text-accent">{t('advisor.recommended')}</span>}
            </label>
          ))}
        </div>
        {pick === 'custom' && (
          <input
            aria-label={t('advisor.custom')}
            className={field}
            placeholder={t('advisor.customPh')}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
      </fieldset>
      <label className="block text-xs text-muted">
        {t('advisor.expectation')}
        <textarea
          aria-label={t('advisor.expectation')}
          className={cn(field, 'min-h-[84px] resize-y')}
          placeholder={t('advisor.expectationPh')}
          value={expectation}
          onChange={(e) => setExpectation(e.target.value)}
        />
      </label>
      <div className="text-xs text-muted">
        {t('advisor.reviewAt')}
        <div className="mt-1.5">
          <Segmented
            label={t('advisor.reviewAt')}
            value={days}
            onChange={setDays}
            options={[
              { value: '14', label: t('advisor.in2w') },
              { value: '30', label: t('advisor.in1m') },
              { value: '90', label: t('advisor.in3m') }
            ]}
          />
        </div>
      </div>
    </PlanDialog>
  )
}

/* ——— 回看 ——— */

function ReviewDialog({ d, onClose }: { d: Decision; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [outcome, setOutcome] = useState(''),
    [accuracy, setAccuracy] = useState<'1' | '2' | '3' | '4' | '5'>('3'),
    [lesson, setLesson] = useState(''),
    [card, setCard] = useState(true),
    [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.advisor.review({
        id: d.id,
        outcome: outcome.trim(),
        accuracy: Number(accuracy),
        lesson: lesson.trim(),
        card: card && !!lesson.trim()
      })
      if (card && lesson.trim()) toast.success(t('advisor.lessonCardDone'))
      void qc.invalidateQueries({ queryKey: ['advisor'] })
      void qc.invalidateQueries({ queryKey: ['today'] })
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <PlanDialog
      title={t('advisor.reviewTitle')}
      description={d.question}
      onClose={onClose}
      testId="review-decision-dialog"
      footer={
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !outcome.trim()} onClick={() => void save()}>
            {t('advisor.save')}
          </Button>
        </div>
      }
    >
      <div className="rounded-xl bg-sunken/60 px-4 py-3 text-sm">
        <p className="text-2xs text-subtle">{t('advisor.decided')}</p>
        <p className="mt-0.5 text-fg">{d.choice}</p>
        <p className="mt-2 text-2xs text-subtle">{t('advisor.expected')}</p>
        <p className="mt-0.5 leading-relaxed whitespace-pre-wrap text-fg">{d.expectation}</p>
      </div>
      <label className="block text-xs text-muted">
        {t('advisor.outcome')}
        <textarea
          aria-label={t('advisor.outcome')}
          className={cn(field, 'min-h-[84px] resize-y')}
          placeholder={t('advisor.outcomePh')}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
        />
      </label>
      <div className="text-xs text-muted">
        {t('advisor.accuracy')}
        <div className="mt-1.5">
          <Segmented
            label={t('advisor.accuracy')}
            value={accuracy}
            onChange={setAccuracy}
            options={(['1', '2', '3', '4', '5'] as const).map((v) => ({ value: v, label: t(`advisor.acc.${v}`) }))}
          />
        </div>
      </div>
      <label className="block text-xs text-muted">
        {t('advisor.lesson')}
        <input
          aria-label={t('advisor.lesson')}
          className={field}
          placeholder={t('advisor.lessonPh')}
          value={lesson}
          onChange={(e) => setLesson(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="accent-[var(--accent)]"
          checked={card}
          disabled={!lesson.trim()}
          onChange={(e) => setCard(e.target.checked)}
        />
        {t('advisor.lessonCard')}
      </label>
    </PlanDialog>
  )
}

export function DueDecisions() {
  const { t } = useTranslation()
  useDecisionEvents()
  const { data: due = [] } = useQuery({ queryKey: ['advisor', 'due'], queryFn: () => api.advisor.due() })
  if (!due.length) return null
  return (
    <section
      className="mt-6 flex items-center gap-3 rounded-2xl border border-accent/25 bg-accent-soft/40 px-5 py-3.5"
      data-testid="decisions-due"
    >
      <AlertTriangle className="size-4 shrink-0 text-accent" />
      <p className="min-w-0 flex-1 truncate text-sm text-fg">
        {t('advisor.dueToday', { count: due.length })}：{due[0].question}
      </p>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 text-accent hover:text-accent"
        onClick={() => {
          useApp.getState().goNav('advisor')
          useApp.setState({ decisionId: due[0].id })
        }}
      >
        {t('advisor.dueOpen')}
        <ChevronDown className="-rotate-90" />
      </Button>
    </section>
  )
}
