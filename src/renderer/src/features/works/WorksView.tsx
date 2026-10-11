import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  Clapperboard,
  FileDown,
  FileText,
  Lightbulb,
  Loader2,
  MoreHorizontal,
  Plus,
  Presentation,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import {
  WORK_STAGES,
  type ArticlePart,
  type SlidePart,
  type Work,
  type WorkMode,
  type WorkParts,
  type WorkStage,
  type WorkType
} from '@shared/works'
import { FloatingPanel } from '@/components/FloatingPanel'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { PlanDialog, Segmented, field } from '@/features/plan/ui'

// 创作工坊（v0.9）：作品列表 + 工作台（选题 → 素材 → 结构 → 起草 → 打磨 → 成品）。

const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const TYPE_ICON: Record<WorkType, ReactNode> = { article: <FileText />, slides: <Presentation />, video: <Clapperboard /> }
/** 当前可新建的类型（讲解视频在 P4 接入后加入） */
export const CREATABLE: WorkType[] = ['article', 'slides']

function useWorkEvents(): void {
  const qc = useQueryClient()
  useEffect(() => window.jiweiEvents.on('works:changed', () => void qc.invalidateQueries({ queryKey: ['works'] })), [qc])
}

export function WorksView() {
  const { t } = useTranslation()
  const workId = useApp((s) => s.workId)
  const [creating, setCreating] = useState<WorkType | null>(null)
  useWorkEvents()
  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('works.title')}</h1>
        {!workId && (
          <Button size="sm" variant="primary" className="no-drag ml-auto" onClick={() => setCreating('article')}>
            <Plus />
            {t('works.create')}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="works-view">
        {workId ? (
          <Workbench id={workId} onBack={() => useApp.setState({ workId: null })} />
        ) : (
          <div className="mx-auto max-w-[920px] px-10 pt-8 pb-16">
            <WorkList onCreate={setCreating} />
          </div>
        )}
      </div>
      {creating && <NewWorkDialog initial={creating} onClose={() => setCreating(null)} />}
    </FloatingPanel>
  )
}

/* ——— 列表 ——— */

function StageDots({ stage }: { stage: WorkStage }) {
  const at = WORK_STAGES.indexOf(stage)
  return (
    <span className="flex gap-1" aria-hidden>
      {WORK_STAGES.map((s, i) => (
        <span key={s} className={cn('h-1 w-4 rounded-full', i <= at ? 'bg-accent' : 'bg-sunken')} />
      ))}
    </span>
  )
}

function WorkList({ onCreate }: { onCreate: (t: WorkType) => void }) {
  const { t, i18n } = useTranslation()
  const { data: list = [] } = useQuery({ queryKey: ['works', 'list'], queryFn: () => api.works.list() })
  if (!list.length)
    return (
      <div>
        <p className="max-w-[680px] text-sm leading-relaxed text-muted">{t('works.intro')}</p>
        <p className="mt-6 text-xs text-subtle">{t('works.empty')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {CREATABLE.map((type) => (
            <button
              key={type}
              className="group rounded-2xl border border-border bg-surface p-5 text-left shadow-[var(--shadow-1)] transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-[var(--shadow-2)]"
              onClick={() => onCreate(type)}
            >
              <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent [&_svg]:size-5">
                {TYPE_ICON[type]}
              </span>
              <p className="mt-3 font-serif text-lg font-semibold text-fg">{t(`works.types.${type}`)}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{t(`works.typeHints.${type}`)}</p>
            </button>
          ))}
        </div>
      </div>
    )
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="works-list">
      {list.map((w) => (
        <button
          key={w.id}
          data-work={w.title || w.topic}
          className="rounded-2xl border border-border bg-surface p-4 text-left shadow-[var(--shadow-1)] transition-[border-color,transform] hover:-translate-y-0.5 hover:border-accent/40"
          onClick={() => useApp.setState({ workId: w.id })}
        >
          <div className="flex items-center gap-2 text-2xs text-subtle">
            <span className="text-accent [&_svg]:size-3.5">{TYPE_ICON[w.type]}</span>
            {t(`works.types.${w.type}`)}
            <span className="ml-auto">{t('works.updated', { date: new Date(w.updatedAt).toLocaleDateString(i18n.language) })}</span>
          </div>
          <p className="mt-2 line-clamp-2 font-serif text-base leading-snug font-semibold text-fg">{w.title || w.topic || '—'}</p>
          <div className="mt-3 flex items-center gap-2">
            <StageDots stage={w.stage} />
            <span className="text-2xs text-muted">{t(`works.steps.${w.stage}`)}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

function NewWorkDialog({ initial, onClose }: { initial: WorkType; onClose: () => void }) {
  const { t } = useTranslation()
  const { data: goals = [] } = useQuery({ queryKey: ['goals'], queryFn: () => api.goals.list() })
  const [type, setType] = useState<WorkType>(initial),
    [topic, setTopic] = useState(''),
    [audience, setAudience] = useState(''),
    [mode, setMode] = useState<WorkMode>('cowrite'),
    [goalId, setGoalId] = useState(''),
    [busy, setBusy] = useState(false)
  const audiences = t('works.audiences', { returnObjects: true }) as string[]
  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const w = await api.works.create({
        type,
        title: topic.trim().slice(0, 120),
        topic: topic.trim(),
        audience: audience.trim(),
        mode,
        goalId: goalId || null
      })
      useApp.setState({ workId: w.id })
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <PlanDialog
      title={t('works.create')}
      onClose={onClose}
      testId="new-work-dialog"
      footer={
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void start()}>
            {t('works.start')}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('works.title')}>
        {CREATABLE.map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={type === k}
            className={cn(
              'flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors',
              type === k ? 'border-accent bg-accent-soft/30' : 'border-border hover:bg-surface-hover'
            )}
            onClick={() => setType(k)}
          >
            <span className="mt-0.5 text-accent [&_svg]:size-4">{TYPE_ICON[k]}</span>
            <span>
              <span className="block text-sm font-medium text-fg">{t(`works.types.${k}`)}</span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-muted">{t(`works.typeHints.${k}`)}</span>
            </span>
          </button>
        ))}
      </div>
      <label className="block text-xs text-muted">
        {t('works.topic')}
        <textarea
          aria-label={t('works.topic')}
          className={cn(field, 'min-h-[64px] resize-none')}
          placeholder={t('works.topicPh')}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        {!topic.trim() && <span className="mt-1 block text-2xs text-subtle">{t('works.topicEmpty')}</span>}
      </label>
      <div className="text-xs text-muted">
        {t('works.audience')}
        <input
          aria-label={t('works.audience')}
          className={field}
          placeholder={t('works.audiencePh')}
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
        />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {audiences.map((a) => (
            <button
              key={a}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-2xs',
                audience === a ? 'border-accent text-accent' : 'border-border text-muted hover:text-fg'
              )}
              onClick={() => setAudience(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div className="text-xs text-muted">
        {t('works.mode')}
        <div className="mt-1.5">
          <Segmented
            label={t('works.mode')}
            value={mode}
            onChange={setMode}
            options={(['coach', 'cowrite', 'ghost'] as const).map((m) => ({ value: m, label: t(`works.modes.${m}`) }))}
          />
        </div>
        <p className="mt-1.5 text-2xs text-subtle">{t(`works.modeHints.${mode}`)}</p>
      </div>
      {goals.length > 0 && (
        <label className="block text-xs text-muted">
          {t('works.direction')}
          <select aria-label={t('works.direction')} className={field} value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">{t('works.noDirection')}</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </label>
      )}
    </PlanDialog>
  )
}

/* ——— 工作台 ——— */

function useRun(): [string | null, (key: string, fn: () => Promise<unknown>) => Promise<void>] {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
      void qc.invalidateQueries({ queryKey: ['works'] })
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(null)
    }
  }
  return [busy, run]
}

function Workbench({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation()
  const { data: w } = useQuery({ queryKey: ['works', 'one', id], queryFn: () => api.works.get(id) })
  const [step, setStep] = useState<WorkStage | null>(null)
  useEffect(() => {
    if (w && !step) setStep(w.stage)
  }, [w, step])
  if (!w || !step) return null
  const at = WORK_STAGES.indexOf(w.stage)
  return (
    <div className="mx-auto flex max-w-[1120px] gap-8 px-8 pt-6 pb-16" data-testid="workbench">
      <aside className="sticky top-6 w-48 shrink-0 self-start">
        <button className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          {t('works.back')}
        </button>
        <p className="mt-4 flex items-center gap-1.5 text-2xs text-subtle">
          <span className="text-accent [&_svg]:size-3.5">{TYPE_ICON[w.type]}</span>
          {t(`works.types.${w.type}`)} · {t(`works.modes.${w.mode}`)}
        </p>
        <ol className="mt-3 space-y-0.5" data-testid="work-steps">
          {WORK_STAGES.map((s, i) => (
            <li key={s}>
              <button
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
                  step === s ? 'bg-surface text-fg shadow-[var(--shadow-1)]' : 'text-muted hover:bg-surface-hover hover:text-fg'
                )}
                aria-current={step === s ? 'step' : undefined}
                onClick={() => setStep(s)}
              >
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold',
                    i < at ? 'bg-accent text-accent-fg' : i === at ? 'border border-accent text-accent' : 'border border-border text-subtle'
                  )}
                >
                  {i < at ? <Check className="size-3" /> : i + 1}
                </span>
                {t(`works.steps.${s}`)}
              </button>
            </li>
          ))}
        </ol>
        <WorkMenu w={w} onRemoved={onBack} />
      </aside>
      <main className="min-w-0 flex-1">
        <h2 className="font-serif text-2xl leading-snug font-semibold text-fg">{w.title || w.topic || t(`works.types.${w.type}`)}</h2>
        {w.audience && (
          <p className="mt-1 text-xs text-muted">
            {t('works.audience')}：{w.audience}
          </p>
        )}
        <div className="mt-6">
          {step === 'topic' && <TopicStep w={w} next={() => setStep('materials')} />}
          {step === 'materials' && <MaterialsStep w={w} next={() => setStep('outline')} />}
          {step === 'outline' && <OutlineStep w={w} next={() => setStep('draft')} />}
          {step === 'draft' && <DraftStep w={w} next={() => setStep('polish')} />}
          {step === 'polish' && <PolishStep w={w} next={() => setStep('done')} />}
          {step === 'done' && <DoneStep w={w} />}
        </div>
      </main>
    </div>
  )
}

function WorkMenu({ w, onRemoved }: { w: Work; onRemoved: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="mt-4 border-t border-border/70 pt-3">
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" className="text-muted">
            <MoreHorizontal />
            {t('works.more')}
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem
            danger
            onSelect={() =>
              void (async () => {
                if (await confirm({ title: t('works.removeTitle'), description: t('works.removeDesc'), danger: true })) {
                  await api.works.remove(w.id)
                  onRemoved()
                }
              })()
            }
          >
            <Trash2 />
            {t('common.delete')}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}

function Busy({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-accent">
      <Loader2 className="size-3.5 animate-spin" />
      {text}
    </p>
  )
}

function NextBar({ children, onNext, disabled }: { children?: ReactNode; onNext: () => void; disabled?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="mt-6 flex items-center gap-2 border-t border-border/70 pt-4">
      {children}
      <Button className="ml-auto" variant="outline" disabled={disabled} onClick={onNext}>
        {t('works.next')}
      </Button>
    </div>
  )
}

/* 1. 选题 */
function TopicStep({ w, next }: { w: Work; next: () => void }) {
  const { t } = useTranslation()
  const [busy, run] = useRun()
  const [topic, setTopic] = useState(w.topic),
    [audience, setAudience] = useState(w.audience)
  const [topics, setTopics] = useState<{ title: string; angle: string; audience: string; why: string }[]>([])
  const save = (patch: { topic?: string; audience?: string; title?: string }) => api.works.update({ id: w.id, ...patch })
  return (
    <div className="space-y-4">
      <label className="block text-xs text-muted">
        {t('works.topic')}
        <textarea
          aria-label={t('works.topic')}
          className={cn(field, 'min-h-[72px] resize-none text-[15px]')}
          placeholder={t('works.topicPh')}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onBlur={() => topic !== w.topic && void save({ topic: topic.trim(), ...(w.title ? {} : { title: topic.trim().slice(0, 120) }) })}
        />
      </label>
      <label className="block text-xs text-muted">
        {t('works.audience')}
        <input
          aria-label={t('works.audience')}
          className={field}
          placeholder={t('works.audiencePh')}
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          onBlur={() => audience !== w.audience && void save({ audience: audience.trim() })}
        />
      </label>
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={!!busy}
          onClick={() => void run('topics', async () => setTopics(await api.works.topics(w.id)))}
        >
          <Sparkles />
          {t('works.suggest')}
        </Button>
        {busy === 'topics' && (
          <div className="mt-3">
            <Busy text={t('works.suggesting')} />
          </div>
        )}
        {topics.length > 0 && (
          <ul className="mt-3 space-y-2" data-testid="topic-suggestions">
            {topics.map((x, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
                <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">{x.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">
                    {x.angle} · {x.audience}
                  </p>
                  <p className="mt-1 text-2xs text-subtle">{x.why}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTopic(`${x.title}：${x.angle}`)
                    setAudience(x.audience)
                    void save({ topic: `${x.title}：${x.angle}`, audience: x.audience, title: x.title })
                  }}
                >
                  {t('works.useTopic')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NextBar
        disabled={!topic.trim()}
        onNext={() => {
          void save({ topic: topic.trim(), audience: audience.trim(), ...(w.title ? {} : { title: topic.trim().slice(0, 120) }) }).then(
            next
          )
        }}
      />
    </div>
  )
}

/* 2. 素材 */
function MaterialsStep({ w, next }: { w: Work; next: () => void }) {
  const { t } = useTranslation()
  const [busy, run] = useRun()
  const [q, setQ] = useState('')
  const auto = useRef(false)
  useEffect(() => {
    if (!auto.current && !w.materials.length && w.topic) {
      auto.current = true
      void run('gather', () => api.works.gather(w.id))
    }
  }, [w, run])
  const open = (m: Work['materials'][number]): void => {
    if (m.available === false) return
    if (m.refType === 'note') useApp.getState().openNote(m.refId)
    else useApp.getState().openSource(m.refId)
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">{t('works.materialsHint')}</p>
      <div className="flex items-center gap-2">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 focus-within:border-accent">
          <Search className="size-3.5 shrink-0 text-subtle" />
          <input
            aria-label={t('works.gatherMore')}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
            placeholder={t('works.gatherPh')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q.trim()) void run('gather', () => api.works.gather(w.id, q.trim())).then(() => setQ(''))
            }}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!!busy}
          onClick={() => void run('gather', () => api.works.gather(w.id, q.trim() || undefined)).then(() => setQ(''))}
        >
          {w.materials.length ? t('works.gatherMore') : t('works.gather')}
        </Button>
      </div>
      {busy === 'gather' && <Busy text={t('works.gathering')} />}
      {!w.materials.length && busy !== 'gather' ? (
        <p className="rounded-2xl border border-dashed border-border-strong px-5 py-6 text-sm text-muted">{t('works.materialsEmpty')}</p>
      ) : (
        <ul className="space-y-2" data-testid="work-materials">
          {w.materials.map((m) => (
            <li
              key={m.id}
              className={cn('group flex gap-3 rounded-xl border border-border bg-surface px-4 py-3', m.available === false && 'opacity-60')}
            >
              <span className="mt-0.5 h-5 shrink-0 rounded-md bg-accent-soft px-1.5 text-2xs leading-5 font-medium text-accent tabular-nums">
                {m.ref}
              </span>
              <button className="min-w-0 flex-1 text-left" onClick={() => open(m)}>
                <p className="truncate text-sm font-medium text-fg">
                  {m.title}
                  {m.available === false && <span className="ml-2 text-2xs font-normal text-warning">{t('works.unavailable')}</span>}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{m.excerpt}</p>
              </button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="opacity-0 group-hover:opacity-100"
                aria-label={t('works.remove')}
                onClick={() => void run('drop', () => api.works.dropMaterial(w.id, m.id))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <NextBar onNext={next} />
    </div>
  )
}

/* 3. 结构 / 4. 起草：本地编辑，停止输入后自动保存 */
function useParts(w: Work): [WorkParts | null, (next: WorkParts) => void, boolean] {
  const [parts, setParts] = useState<WorkParts | null>(w.content)
  const [dirty, setDirty] = useState(false)
  const timer = useRef<number>(0)
  const latest = useRef<WorkParts | null>(null)
  // 服务端内容更新（AI 生成）时同步；正在编辑时不覆盖
  useEffect(() => {
    if (!dirty) setParts(w.content)
  }, [w.content, dirty])
  useEffect(
    () => () => {
      if (latest.current) void api.works.update({ id: w.id, content: latest.current })
      window.clearTimeout(timer.current)
    },
    [w.id]
  )
  const update = (next: WorkParts): void => {
    setParts(next)
    setDirty(true)
    latest.current = next
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void api.works.update({ id: w.id, content: next }).finally(() => {
        latest.current = null
        setDirty(false)
      })
    }, 600)
  }
  return [parts, update, dirty]
}

const newPartId = (): string => Math.random().toString(36).slice(2, 10)
const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)

function PartFrame({
  index,
  total,
  onMove,
  onDelete,
  children,
  refs
}: {
  index: number
  total: number
  onMove: (d: -1 | 1) => void
  onDelete: () => void
  children: ReactNode
  refs: string[]
}) {
  const { t } = useTranslation()
  return (
    <li className="group relative rounded-2xl border border-border bg-surface px-4 py-3 shadow-[var(--shadow-1)]" data-part={index}>
      <div className="flex items-start gap-3">
        <span className="mt-2 grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-2xs font-semibold text-muted tabular-nums">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">{children}</div>
        <div className="flex shrink-0 flex-col opacity-40 transition-opacity group-hover:opacity-100">
          <Button size="icon-sm" variant="ghost" aria-label={t('works.moveUp')} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={t('works.moveDown')} disabled={index === total - 1} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={t('works.deletePart')} onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      </div>
      {refs.length > 0 && (
        <p className="mt-2 ml-9 flex flex-wrap gap-1">
          {refs.map((r) => (
            <span key={r} className="rounded bg-accent-soft px-1.5 text-[10px] leading-4 text-accent">
              {r}
            </span>
          ))}
        </p>
      )}
    </li>
  )
}

function move<T>(arr: T[], i: number, d: -1 | 1): T[] {
  const out = [...arr]
  ;[out[i], out[i + d]] = [out[i + d], out[i]]
  return out
}

function OutlineStep({ w, next }: { w: Work; next: () => void }) {
  const { t } = useTranslation()
  const [busy, run] = useRun()
  const [content, update] = useParts(w)
  const kind = w.type === 'slides' ? 'slides' : 'article'
  const add = (): void => {
    if (!content) return
    if (content.kind === 'article')
      update({ kind: 'article', parts: [...content.parts, { id: newPartId(), title: '', points: [], sources: [], body: '' }] })
    else update({ kind: 'slides', parts: [...content.parts, { id: newPartId(), title: '', bullets: [], notes: '', sources: [] }] })
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant={content ? 'outline' : 'primary'}
          size="sm"
          disabled={!!busy}
          onClick={() => void run('outline', () => api.works.outline(w.id))}
        >
          {content ? <RotateCcw /> : <Sparkles />}
          {content ? t('works.regenerateOutline') : t('works.outline')}
        </Button>
        {content && <span className="text-2xs text-subtle">{t('works.outlineHint')}</span>}
      </div>
      {busy === 'outline' && <Busy text={t('works.outlining')} />}
      {content && (
        <ol className="space-y-2.5" data-testid="work-outline">
          {content.kind === 'article'
            ? content.parts.map((p, i) => (
                <PartFrame
                  key={p.id}
                  index={i}
                  total={content.parts.length}
                  refs={p.sources}
                  onMove={(d) => update({ kind: 'article', parts: move(content.parts, i, d) })}
                  onDelete={() => update({ kind: 'article', parts: content.parts.filter((x) => x.id !== p.id) })}
                >
                  <input
                    aria-label={t('works.partTitle')}
                    className="w-full bg-transparent py-1 text-[15px] font-semibold text-fg outline-none"
                    value={p.title}
                    placeholder={t('works.partTitle')}
                    onChange={(e) =>
                      update({ kind: 'article', parts: content.parts.map((x) => (x.id === p.id ? { ...x, title: e.target.value } : x)) })
                    }
                  />
                  <textarea
                    aria-label={t('works.points')}
                    className="mt-1 block w-full resize-none bg-transparent text-sm leading-relaxed text-muted outline-none"
                    rows={Math.max(2, p.points.length)}
                    value={p.points.join('\n')}
                    placeholder={t('works.points')}
                    onChange={(e) =>
                      update({
                        kind: 'article',
                        parts: content.parts.map((x) => (x.id === p.id ? { ...x, points: e.target.value.split('\n') } : x))
                      })
                    }
                  />
                </PartFrame>
              ))
            : content.parts.map((p, i) => (
                <PartFrame
                  key={p.id}
                  index={i}
                  total={content.parts.length}
                  refs={p.sources}
                  onMove={(d) => update({ kind: 'slides', parts: move(content.parts, i, d) })}
                  onDelete={() => update({ kind: 'slides', parts: content.parts.filter((x) => x.id !== p.id) })}
                >
                  <input
                    aria-label={t('works.partTitle')}
                    className="w-full bg-transparent py-1 text-[15px] font-semibold text-fg outline-none"
                    value={p.title}
                    placeholder={t('works.partTitle')}
                    onChange={(e) =>
                      update({ kind: 'slides', parts: content.parts.map((x) => (x.id === p.id ? { ...x, title: e.target.value } : x)) })
                    }
                  />
                  <textarea
                    aria-label={t('works.bullets')}
                    className="mt-1 block w-full resize-none bg-transparent text-sm leading-relaxed text-muted outline-none"
                    rows={Math.max(2, p.bullets.length)}
                    value={p.bullets.join('\n')}
                    onChange={(e) =>
                      update({
                        kind: 'slides',
                        parts: content.parts.map((x) => (x.id === p.id ? { ...x, bullets: e.target.value.split('\n') } : x))
                      })
                    }
                  />
                </PartFrame>
              ))}
        </ol>
      )}
      {content && (
        <Button size="sm" variant="ghost" onClick={add}>
          <Plus />
          {t(`works.addPart.${kind}`)}
        </Button>
      )}
      <NextBar disabled={!content?.parts.length} onNext={next} />
    </div>
  )
}

function DraftStep({ w, next }: { w: Work; next: () => void }) {
  const { t } = useTranslation()
  const [busy, run] = useRun()
  const [content, update] = useParts(w)
  if (!content) return <p className="text-sm text-muted">{t('works.outline')}</p>
  if (content.kind === 'slides')
    return (
      <div className="space-y-4">
        <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void run('draft', () => api.works.draft(w.id))}>
          <Sparkles />
          {t('works.draftSlides')}
        </Button>
        {busy === 'draft' && <Busy text={t('works.drafting')} />}
        <ol className="grid gap-4 lg:grid-cols-2" data-testid="work-slides">
          {content.parts.map((p, i) => (
            <SlideCard
              key={p.id}
              p={p}
              i={i}
              total={content.parts.length}
              onChange={(np) => update({ kind: 'slides', parts: content.parts.map((x) => (x.id === p.id ? np : x)) })}
            />
          ))}
        </ol>
        <NextBar onNext={next} />
      </div>
    )
  const words = content.parts.reduce((n, p) => n + p.body.replace(/\s/g, '').length, 0)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void run('draft', () => api.works.draft(w.id))}>
          <Sparkles />
          {t(`works.draftAll.${w.mode}`)}
        </Button>
        <span className="ml-auto text-2xs text-subtle tabular-nums">{t('works.words', { count: words })}</span>
      </div>
      {busy === 'draft' && <Busy text={t('works.drafting')} />}
      <ol className="space-y-4" data-testid="work-sections">
        {content.parts.map((p) => (
          <SectionEditor
            key={p.id}
            p={p}
            mode={w.mode}
            busy={busy === p.id}
            onDraft={() => void run(p.id, () => api.works.draft(w.id, p.id))}
            onChange={(np) => update({ kind: 'article', parts: content.parts.map((x) => (x.id === p.id ? np : x)) })}
          />
        ))}
      </ol>
      <NextBar onNext={next} />
    </div>
  )
}

function SectionEditor({
  p,
  mode,
  busy,
  onDraft,
  onChange
}: {
  p: ArticlePart
  mode: WorkMode
  busy: boolean
  onDraft: () => void
  onChange: (p: ArticlePart) => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLTextAreaElement>(null)
  // 随内容自动增高
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(120, el.scrollHeight)}px`
  }, [p.body])
  return (
    <li className="rounded-2xl border border-border bg-surface px-5 py-4 shadow-[var(--shadow-1)]" data-section={p.title}>
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 font-serif text-lg font-semibold text-fg">{p.title}</h3>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDraft}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {p.body.trim() || p.coach ? t('works.rewrite') : t(`works.draftOne.${mode}`)}
        </Button>
      </div>
      {p.points.filter(Boolean).length > 0 && (
        <p className="mt-1 text-xs leading-relaxed text-subtle">{p.points.filter(Boolean).join(' · ')}</p>
      )}
      {p.coach && (
        <div className="mt-3 rounded-xl bg-accent-soft/40 px-4 py-3 text-sm" data-testid="coach-questions">
          <p className="text-2xs font-medium text-accent">{t('works.coachQuestions')}</p>
          <ul className="mt-1.5 space-y-1 text-fg">
            {p.coach.questions.map((q, i) => (
              <li key={i}>· {q}</li>
            ))}
          </ul>
          {p.coach.tips.length > 0 && (
            <>
              <p className="mt-2 text-2xs font-medium text-accent">{t('works.coachTips')}</p>
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {p.coach.tips.map((q, i) => (
                  <li key={i}>· {q}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <textarea
        ref={ref}
        aria-label={p.title}
        className="mt-3 block w-full resize-none rounded-lg bg-transparent text-[15px] leading-[1.85] text-fg outline-none placeholder:text-subtle"
        placeholder={t('works.bodyPh')}
        value={p.body}
        onChange={(e) => onChange({ ...p, body: e.target.value })}
      />
    </li>
  )
}

function SlideCard({ p, i, total, onChange }: { p: SlidePart; i: number; total: number; onChange: (p: SlidePart) => void }) {
  const { t } = useTranslation()
  return (
    <li className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-1)]" data-slide={i}>
      {/* 16:9 预览：与导出的版式一致 */}
      <div className="relative aspect-video border-b border-border/70 bg-[#FBFCFA] px-[7%] pt-[6%] text-[#1F2523] dark:bg-[#FBFCFA]">
        {i === 0 ? (
          <>
            <span className="absolute inset-y-0 left-0 w-[2.6%] bg-[#2F6F62]" />
            <p className="absolute right-[7%] bottom-[46%] left-[8%] font-serif text-[clamp(14px,2.2vw,24px)] leading-tight font-bold">
              {p.title}
            </p>
            <p className="absolute top-[56%] right-[7%] left-[8%] text-[clamp(9px,1vw,12px)] text-[#6B746F]">{p.bullets.join(' · ')}</p>
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 font-serif text-[clamp(11px,1.4vw,16px)] font-bold">
              <span className="h-[1.1em] w-1 bg-[#2F6F62]" />
              {p.title}
            </p>
            <ul className="mt-[4%] space-y-[2%] text-[clamp(8px,0.95vw,11px)]">
              {p.bullets.map((b, k) => (
                <li key={k} className="flex gap-1.5">
                  <span className="mt-[0.45em] size-1 shrink-0 bg-[#2F6F62]" />
                  {b}
                </li>
              ))}
            </ul>
            <span className="absolute inset-x-0 bottom-0 flex h-[5%] items-center justify-end bg-[#E7F0EC] px-[3%] text-[clamp(6px,0.6vw,8px)] text-[#6B746F]">
              {i + 1} / {total}
            </span>
          </>
        )}
      </div>
      <div className="space-y-2 px-4 py-3">
        <input
          aria-label={t('works.partTitle')}
          className="w-full bg-transparent text-sm font-semibold text-fg outline-none"
          value={p.title}
          onChange={(e) => onChange({ ...p, title: e.target.value })}
        />
        <textarea
          aria-label={t('works.bullets')}
          className="block w-full resize-none bg-transparent text-xs leading-relaxed text-fg outline-none"
          rows={Math.max(2, p.bullets.length)}
          value={p.bullets.join('\n')}
          onChange={(e) => onChange({ ...p, bullets: e.target.value.split('\n') })}
          onBlur={() => onChange({ ...p, bullets: lines(p.bullets.join('\n')) })}
        />
        <textarea
          aria-label={t('works.notes')}
          className="block w-full resize-none rounded-lg bg-sunken/60 px-2.5 py-2 text-xs leading-relaxed text-muted outline-none"
          rows={3}
          placeholder={t('works.notes')}
          value={p.notes}
          onChange={(e) => onChange({ ...p, notes: e.target.value })}
        />
      </div>
    </li>
  )
}

/* 5. 打磨 */
function PolishStep({ w, next }: { w: Work; next: () => void }) {
  const { t } = useTranslation()
  const [busy, run] = useRun()
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const titleOf = (i: number): string => w.content?.parts[i]?.title ?? ''
  const pol = w.polish
  useEffect(() => setPicked(new Set((pol?.unclear ?? []).map((_, i) => i))), [pol])
  const Part = ({ i }: { i: number }) => <span className="text-2xs text-subtle">{t('works.inPart', { n: i + 1, title: titleOf(i) })}</span>
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted">{t('works.polishHint')}</p>
      <Button
        variant={pol ? 'outline' : 'primary'}
        size="sm"
        disabled={!!busy || !w.content}
        onClick={() => void run('polish', () => api.works.polish(w.id))}
      >
        {pol ? <RotateCcw /> : <Sparkles />}
        {pol ? t('works.repolish') : t('works.polish')}
      </Button>
      {busy === 'polish' && <Busy text={t('works.polishing')} />}
      {pol && (
        <div className="space-y-4" data-testid="work-polish">
          {!pol.audience.length && !pol.facts.length && !pol.unclear.length && <p className="text-sm text-muted">{t('works.allGood')}</p>}
          {pol.audience.length > 0 && (
            <section className="paper rounded-2xl px-5 py-4 shadow-[var(--shadow-1)]">
              <h3 className="text-sm font-semibold text-fg">{t('works.audienceIssues')}</h3>
              <ul className="mt-2 space-y-2.5">
                {pol.audience.map((x, i) => (
                  <li key={i} className="text-sm leading-relaxed">
                    <Part i={x.part} />
                    <p className="text-fg">{x.issue}</p>
                    {x.suggestion && <p className="text-xs text-muted">↳ {x.suggestion}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {pol.facts.length > 0 && (
            <section className="paper rounded-2xl px-5 py-4 shadow-[var(--shadow-1)]">
              <h3 className="text-sm font-semibold text-fg">{t('works.facts')}</h3>
              <ul className="mt-2 space-y-2.5">
                {pol.facts.map((x, i) => (
                  <li key={i} className="text-sm leading-relaxed">
                    <Part i={x.part} />
                    <p className="border-l-2 border-warning/60 pl-2.5 text-fg">“{x.quote}”</p>
                    <p className={cn('mt-0.5 text-xs', x.verdict === 'contradicted' ? 'text-danger' : 'text-warning')}>
                      {t(`works.verdict.${x.verdict}`)}
                      {x.source ? ` · ${x.source}` : ''}
                      {x.note ? ` · ${x.note}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {pol.unclear.length > 0 && (
            <section className="paper rounded-2xl px-5 py-4 shadow-[var(--shadow-1)]">
              <h3 className="text-sm font-semibold text-fg">{t('works.unclear')}</h3>
              <p className="mt-0.5 text-2xs text-subtle">{t('works.unclearHint')}</p>
              <ul className="mt-2 space-y-2">
                {pol.unclear.map((x, i) => (
                  <li key={i}>
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 accent-[var(--accent)]"
                        checked={picked.has(i)}
                        onChange={(e) => {
                          const s = new Set(picked)
                          if (e.target.checked) s.add(i)
                          else s.delete(i)
                          setPicked(s)
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block text-fg">{x.question}</span>
                        <span className="block text-xs text-muted">{x.point}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                disabled={!picked.size || !!busy}
                onClick={() =>
                  void run('cards', async () => {
                    const r = await api.works.unclearToCards(w.id, [...picked])
                    toast.success(t('works.cardsDone', { count: r.count, title: `${w.title || w.topic} · 回流` }))
                  })
                }
              >
                <BookOpen />
                {t('works.makeCards')}
              </Button>
            </section>
          )}
        </div>
      )}
      <NextBar onNext={next} />
    </div>
  )
}

/* 6. 成品 */
function DoneStep({ w }: { w: Work }) {
  const { t, i18n } = useTranslation()
  const [busy, run] = useRun()
  const [where, setWhere] = useState(w.publishedWhere ?? ''),
    [retro, setRetro] = useState(w.retrospective ?? '')
  const formats: ('md' | 'docx' | 'pdf' | 'pptx')[] = w.type === 'slides' ? ['pptx', 'md'] : ['docx', 'pdf', 'md']
  const label: Record<string, string> = { md: 'Markdown', docx: 'Word', pdf: 'PDF', pptx: 'PowerPoint' }
  const used = w.materials.filter((m) => m.used).length
  const cited = useMemo(() => new Set((w.content?.parts ?? []).flatMap((p) => p.sources)).size, [w.content])
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-fg">{t('works.export')}</h3>
        <div className="mt-3 flex flex-wrap gap-2" data-testid="work-export">
          {formats.map((f) => (
            <Button
              key={f}
              variant={f === formats[0] ? 'primary' : 'outline'}
              size="sm"
              disabled={!!busy || !w.content}
              onClick={() =>
                void run(`export-${f}`, async () => {
                  const path = await api.works.export(w.id, f)
                  if (path)
                    toast.success(t('works.exported', { path: path.split(/[\\/]/).pop() }), {
                      action: { label: t('works.reveal'), onClick: () => void api.app.showInFolder(path) }
                    })
                })
              }
            >
              {busy === `export-${f}` ? <Loader2 className="animate-spin" /> : <FileDown />}
              {label[f]}
            </Button>
          ))}
        </div>
        {w.materials.length > 0 && (
          <p className="mt-3 text-xs text-muted">{t('works.used', { used: used || cited, total: w.materials.length })}</p>
        )}
        {w.exports.length > 0 && (
          <ul className="mt-3 space-y-1 text-2xs text-subtle">
            {w.exports
              .slice()
              .reverse()
              .slice(0, 5)
              .map((e, i) => (
                <li key={i} className="truncate">
                  {new Date(e.at).toLocaleString(i18n.language)} · {label[e.format] ?? e.format} · {e.path}
                </li>
              ))}
          </ul>
        )}
      </section>
      <label className="block text-xs text-muted">
        {t('works.published')}
        <input
          aria-label={t('works.published')}
          className={field}
          placeholder={t('works.publishedPh')}
          value={where}
          onChange={(e) => setWhere(e.target.value)}
          onBlur={() => where !== (w.publishedWhere ?? '') && void api.works.update({ id: w.id, publishedWhere: where.trim() || null })}
        />
      </label>
      <label className="block text-xs text-muted">
        {t('works.retro')}
        <textarea
          aria-label={t('works.retro')}
          className={cn(field, 'min-h-[96px] resize-y')}
          placeholder={t('works.retroPh')}
          value={retro}
          onChange={(e) => setRetro(e.target.value)}
          onBlur={() => retro !== (w.retrospective ?? '') && void api.works.update({ id: w.id, retrospective: retro.trim() || null })}
        />
      </label>
    </div>
  )
}
