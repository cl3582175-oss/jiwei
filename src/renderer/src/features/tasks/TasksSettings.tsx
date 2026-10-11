import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { AiTask, TaskInput, TaskOutputs, Trigger } from '@shared/tasks'
import type { z } from 'zod'
import { History, Loader2, Pencil, Play, Plus, Sparkles, Trash2 } from 'lucide-react'
import { api, cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/primitives'
import { useSettings } from '@/lib/queries'
import { useMoney } from '@/lib/money'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { NotePicker } from '../notes/NotePicker'

const field =
  'mt-1 block w-full min-w-0 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-fg outline-none focus:border-accent'
const initial: TaskInput = {
  name: '',
  instruction: '',
  trigger: { type: 'manual' },
  tools: [],
  outputs: { inbox: true },
  enabled: true,
  budgetPerRun: null,
  recipe: null
}
const defaultTrigger = (type: Trigger['type']): Trigger =>
  type === 'schedule'
    ? { type, every: 'day', time: '08:00' }
    : type === 'interval'
      ? { type, minutes: 60 }
      : type === 'web'
        ? { type, url: 'https://' }
        : type === 'folder'
          ? { type, path: '' }
          : type === 'calendar'
            ? { type, minutesBefore: 30 }
            : type === 'mistakes'
              ? { type, count: 3 }
              : type === 'deadline'
                ? { type, days: 7 }
                : type === 'mail'
                  ? { type, accountId: '' }
                  : { type: 'manual' }
export function TriggerEditor({ value, onChange }: { value: Trigger; onChange: (t: Trigger) => void }) {
  const { t } = useTranslation()
  const { data: accounts = [] } = useQuery({ queryKey: ['mail-accounts'], queryFn: () => api.mail.accounts() })
  return (
    <div className="space-y-3">
      <label className="block text-xs text-muted">
        {t('tasks.trigger')}
        <select
          className={field}
          aria-label={t('tasks.trigger')}
          value={value.type}
          onChange={(e) => onChange(defaultTrigger(e.target.value as Trigger['type']))}
        >
          {(['schedule', 'interval', 'mail', 'web', 'folder', 'calendar', 'mistakes', 'deadline', 'manual'] as const).map((type) => (
            <option key={type} value={type}>
              {t(`tasks.triggerTypes.${type}`)}
            </option>
          ))}
        </select>
      </label>
      {value.type === 'schedule' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <select
              className={field}
              value={value.every}
              aria-label={t('tasks.days')}
              onChange={(e) => onChange({ ...value, every: e.target.value as 'day' | 'weekday' | 'week', days: [1] })}
            >
              {(['day', 'weekday', 'week'] as const).map((d) => (
                <option key={d} value={d}>
                  {t(`tasks.every.${d}`)}
                </option>
              ))}
            </select>
            <label className="text-xs text-muted">
              {t('tasks.time')}
              <input
                aria-label={t('tasks.time')}
                type="time"
                className={field}
                value={value.time}
                onChange={(e) => onChange({ ...value, time: e.target.value })}
              />
            </label>
          </div>
          {value.every === 'week' && (
            <div className="flex flex-wrap gap-3">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <label key={d} className="flex gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={value.days?.includes(d) ?? false}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        days: e.target.checked ? [...(value.days ?? []), d] : (value.days ?? []).filter((v) => v !== d)
                      })
                    }
                  />
                  {t(`plan.days.${d}`)}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {value.type === 'mail' && (
        <>
          <label className="text-xs text-muted">
            {t('tasks.mailAccount')}
            <select
              className={field}
              aria-label={t('tasks.mailAccount')}
              value={value.accountId}
              onChange={(e) => onChange({ ...value, accountId: e.target.value })}
            >
              <option value="">—</option>
              {accounts
                .filter((a) => a.enabled)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.username}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-xs text-muted">
            {t('tasks.from')}
            <input className={field} value={value.from ?? ''} onChange={(e) => onChange({ ...value, from: e.target.value || undefined })} />
          </label>
          <label className="block text-xs text-muted">
            {t('tasks.subject')}
            <input
              className={field}
              value={value.subjectContains ?? ''}
              onChange={(e) => onChange({ ...value, subjectContains: e.target.value || undefined })}
            />
          </label>
        </>
      )}
      {value.type === 'interval' && (
        <label className="text-xs text-muted">
          {t('tasks.minutes')}
          <input
            className={field}
            type="number"
            min="30"
            value={value.minutes}
            onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })}
          />
        </label>
      )}
      {value.type === 'web' && (
        <>
          <label className="text-xs text-muted">
            {t('tasks.url')}
            <input
              className={field}
              aria-label={t('tasks.url')}
              value={value.url}
              onChange={(e) => onChange({ ...value, url: e.target.value })}
            />
          </label>
          <label className="text-xs text-muted">
            {t('tasks.selector')}
            <input
              className={field}
              value={value.selector ?? ''}
              onChange={(e) => onChange({ ...value, selector: e.target.value || undefined })}
            />
          </label>
        </>
      )}
      {value.type === 'folder' && (
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-xs text-muted">
            {t('tasks.folder')}
            <input className={field} value={value.path} onChange={(e) => onChange({ ...value, path: e.target.value })} />
          </label>
          <Button size="sm" onClick={() => void api.tasks.chooseFolder().then((path) => path && onChange({ ...value, path }))}>
            {t('tasks.chooseFolder')}
          </Button>
        </div>
      )}
      {value.type === 'calendar' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-muted">
            {t('tasks.before')} · {t('tasks.minutes')}
            <input
              className={field}
              type="number"
              min="0"
              value={value.minutesBefore}
              onChange={(e) => onChange({ ...value, minutesBefore: Number(e.target.value) })}
            />
          </label>
          <select
            className={field}
            value={value.kind ?? ''}
            onChange={(e) => onChange({ ...value, kind: (e.target.value || undefined) as typeof value.kind })}
          >
            <option value="">{t('common.all')}</option>
            {['exam', 'event', 'study'].map((k) => (
              <option key={k} value={k}>
                {t(`plan.kinds.${k}`)}
              </option>
            ))}
          </select>
        </div>
      )}
      {value.type === 'mistakes' && (
        <label className="text-xs text-muted">
          {t('tasks.count')}
          <input
            className={field}
            type="number"
            min="1"
            value={value.count}
            onChange={(e) => onChange({ ...value, count: Number(e.target.value) })}
          />
        </label>
      )}
      {value.type === 'deadline' && (
        <label className="text-xs text-muted">
          {t('tasks.before')} · {t('tasks.days')}
          <input
            className={field}
            type="number"
            min="0"
            value={value.days}
            onChange={(e) => onChange({ ...value, days: Number(e.target.value) })}
          />
        </label>
      )}
    </div>
  )
}
function TaskEditor({ input, onClose }: { input: TaskInput; onClose: () => void }) {
  const { t } = useTranslation(),
    { data: settings } = useSettings(),
    [v, setV] = useState(input),
    [busy, setBusy] = useState(false),
    [picker, setPicker] = useState(false)
  const { data: tools = [] } = useQuery({ queryKey: ['task-tools'], queryFn: () => api.tasks.tools() })
  const { data: note } = useQuery({
    queryKey: ['task-note', v.outputs.noteId],
    queryFn: () => (v.outputs.noteId ? api.notes.get(v.outputs.noteId) : null)
  })
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.tasks.save(v)
      onClose()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  const output = (key: keyof Omit<z.infer<typeof TaskOutputs>, 'noteId'>, enabled: boolean): void =>
    setV({ ...v, outputs: { ...v.outputs, [key]: enabled ? true : undefined } })
  return (
    <div className="space-y-4 pt-3" data-testid="task-editor">
      {v.recipe === 'daily-picks' && <p className="text-xs text-accent">{t('discover.recipeHint')}</p>}
      <p className="text-xs text-muted">{t('tasks.parsePreview')}</p>
      <label className="block text-xs text-muted">
        {t('tasks.name')}
        <input aria-label={t('tasks.name')} className={field} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      </label>
      <label className="block text-xs text-muted">
        {t('tasks.instruction')}
        <textarea
          aria-label={t('tasks.instruction')}
          className={field}
          rows={4}
          value={v.instruction}
          onChange={(e) => setV({ ...v, instruction: e.target.value })}
        />
      </label>
      <TriggerEditor value={v.trigger} onChange={(trigger) => setV({ ...v, trigger })} />
      {v.recipe !== 'daily-picks' && <fieldset className="space-y-2">
        <legend className="text-sm text-fg">{t('tasks.tools')}</legend>
        {(['knowledge', 'plan', 'mail', 'web', 'mcp'] as const).map((group) => (
          <div key={group}>
            {!!tools.filter((tool) => tool.group === group).length && (
              <p className="mt-3 text-xs text-muted">{t(`tasks.groups.${group}`)}</p>
            )}
            <div className="mt-1 grid grid-cols-2 gap-2">
              {tools
                .filter((tool) => tool.group === group)
                .map((tool) => (
                  <label key={tool.name} title={tool.label} className="flex min-w-0 items-start gap-2 text-xs text-fg">
                    <input
                      type="checkbox"
                      disabled={!tool.available}
                      checked={v.tools.includes(tool.name)}
                      onChange={(e) =>
                        setV({ ...v, tools: e.target.checked ? [...v.tools, tool.name] : v.tools.filter((name) => name !== tool.name) })
                      }
                    />
                    <span className="min-w-0 break-words">
                      {t(`tasks.toolLabels.${tool.name}`, { defaultValue: tool.name })}
                      {tool.reason && <span className="block text-subtle">{tool.reason}</span>}
                    </span>
                  </label>
                ))}
            </div>
          </div>
        ))}
        <p className="text-2xs text-subtle">{t('tasks.toolHint')}</p>
      </fieldset>}
      <fieldset>
        <legend className="text-sm text-fg">{t('tasks.outputs')}</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {(['inbox', 'briefing', 'notify', 'actions'] as const).filter((key) => v.recipe !== 'daily-picks' || key !== 'actions').map((key) => (
            <label key={key} className="flex gap-1 text-xs text-fg">
              <input type="checkbox" disabled={v.recipe === 'daily-picks' && key === 'inbox'} checked={!!v.outputs[key]} onChange={(e) => output(key, e.target.checked)} />
              {t(`tasks.output.${key}`)}
            </label>
          ))}
        </div>
        {v.recipe !== 'daily-picks' && <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => setPicker(true)}>
            {t('tasks.note')}
          </Button>
          {v.outputs.noteId && (
            <>
              <span className="min-w-0 truncate text-xs text-fg">{note?.title ?? v.outputs.noteId}</span>
              <Button size="sm" variant="ghost" onClick={() => setV({ ...v, outputs: { ...v.outputs, noteId: undefined } })}>
                {t('plan.unlink')}
              </Button>
            </>
          )}
        </div>}
      </fieldset>
      <label className="block text-xs text-muted">
        {t('tasks.budget')} ({settings?.budget.currency ?? settings?.money.currency})
        <input
          type="number"
          className={field}
          min="0"
          step="0.01"
          value={v.budgetPerRun ?? ''}
          onChange={(e) => setV({ ...v, budgetPerRun: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </label>
      <label className="flex gap-2 text-xs text-fg">
        <input type="checkbox" checked={v.enabled ?? true} onChange={(e) => setV({ ...v, enabled: e.target.checked })} />
        {t('tasks.enabled')}
      </label>
      <div className="flex justify-end gap-2">
        <Button disabled={busy} variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={busy || !v.name.trim() || !v.instruction.trim()} variant="primary" onClick={() => void save()}>
          {t('common.save')}
        </Button>
      </div>
      {picker && (
        <NotePicker
          open={picker}
          onOpenChange={setPicker}
          title={t('tasks.note')}
          onPick={(noteId) => {
            setV({ ...v, outputs: { ...v.outputs, noteId } })
            setPicker(false)
          }}
        />
      )}
    </div>
  )
}
export function triggerLabel(v: Trigger, t: (key: string) => string): string {
  return v.type === 'schedule'
    ? `${t(`tasks.every.${v.every}`)} ${v.time}${v.every === 'week' ? ' · ' + v.days?.map((d) => t(`plan.days.${d}`)).join(', ') : ''}`
    : v.type === 'interval'
      ? `${v.minutes} ${t('tasks.minutes')}`
      : t(`tasks.triggerTypes.${v.type}`)
}
export function TasksSettings() {
  const { t, i18n } = useTranslation(),
    money = useMoney(),
    qc = useQueryClient(),
    { data: settings } = useSettings(),
    focus = useApp((s) => s.taskFocusId)
  const { data: list = [] } = useQuery({ queryKey: ['tasks'], queryFn: () => api.tasks.list() }),
    { data: recipes = [] } = useQuery({ queryKey: ['task-recipes'], queryFn: () => api.tasks.recipes() })
  const [editing, setEditing] = useState<TaskInput | null>(null),
    [description, setDescription] = useState(''),
    [parsing, setParsing] = useState(false),
    [selected, setSelected] = useState<string | null>(focus)
  useEffect(() => setSelected(focus), [focus])
  useEffect(() => {
    const off = window.jiweiEvents.on('tasks:changed', () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['task-runs'] })
    })
    return off
  }, [qc])
  const { data: runs = [] } = useQuery({
    queryKey: ['task-runs', selected],
    queryFn: () => (selected ? api.tasks.runs(selected) : []),
    enabled: !!selected,
    refetchInterval: 3000
  })
  const parse = async (): Promise<void> => {
    if (!description.trim()) return
    setParsing(true)
    try {
      setEditing(await api.tasks.parse(description))
    } catch (e) {
      toast.error(String(e))
    } finally {
      setParsing(false)
    }
  }
  const toggle = async (task: AiTask): Promise<void> => {
    try {
      await api.tasks.save({ ...task, enabled: !task.enabled })
    } catch (e) {
      toast.error(String(e))
    }
  }
  const remove = async (task: AiTask): Promise<void> => {
    if (await confirm({ title: t('tasks.remove'), description: task.name, danger: true })) {
      await api.tasks.remove(task.id)
      if (selected === task.id) setSelected(null)
    }
  }
  if (editing)
    return (
      <TaskEditor
        key={editing.id ?? editing.name}
        input={editing}
        onClose={() => {
          setEditing(null)
          void qc.invalidateQueries({ queryKey: ['tasks'] })
        }}
      />
    )
  return (
    <div className="space-y-6 py-3" data-testid="tasks-settings">
      <p className="text-xs leading-relaxed text-muted">{t('tasks.intro')}</p>
      {/* 一句话创建 */}
      <div className="rounded-2xl border border-border bg-surface p-1.5 shadow-[var(--shadow-1)] focus-within:border-accent/60">
        <div className="flex items-center gap-2">
          <Sparkles className="ml-2 size-4 shrink-0 text-accent" />
          <input
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
            aria-label={t('tasks.describe')}
            placeholder={t('tasks.describePh')}
            value={description}
            disabled={parsing}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void parse()
            }}
          />
          <Button size="sm" variant="primary" disabled={parsing || !description.trim()} onClick={() => void parse()}>
            {parsing && <Loader2 className="animate-spin" />}
            {parsing ? t('tasks.parsing') : t('tasks.parse')}
          </Button>
        </div>
      </div>
      <div>
        <p className="mb-2 text-xs text-muted">{t('tasks.fromRecipe')}</p>
        <div className="flex flex-wrap gap-1.5">
          {recipes.map((r) => (
            <button
              key={r.id}
              onClick={() => setEditing({ ...r.task })}
              className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg transition-colors hover:border-accent/50 hover:bg-accent-soft/40"
            >
              {i18n.language.startsWith('zh') ? r.name.zh : r.name.en}
            </button>
          ))}
          <button
            onClick={() => setEditing({ ...initial })}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs text-muted hover:bg-surface-hover hover:text-fg"
          >
            <Plus className="size-3.5" />
            {t('tasks.new')}
          </button>
        </div>
      </div>
      <section>
        <div className="mb-2 flex items-center gap-3">
          <h3 className="mr-auto text-sm font-medium text-fg">{t('tasks.mine')}</h3>
          <label className="flex items-center gap-2 text-xs text-muted">
            {t('tasks.pauseAll')}
            <Switch
              checked={settings?.tasks.paused ?? false}
              aria-label={t('tasks.pauseAll')}
              onCheckedChange={(v) => void api.tasks.pauseAll(v).then(() => qc.invalidateQueries({ queryKey: ['settings'] }))}
            />
          </label>
        </div>
        {list.length === 0 && (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs leading-relaxed text-muted">{t('tasks.empty')}</p>
        )}
        <div className="space-y-2">
          {list.map((task) => {
            const status = task.lastResult?.status
            return (
              <article key={task.id} className={cn('rounded-xl border border-border/80 bg-surface px-4 py-3', !task.enabled && 'opacity-70')} data-task-id={task.id}>
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      !task.enabled ? 'bg-subtle' : status === 'error' || status === 'budget' ? 'bg-danger' : status === 'running' ? 'animate-pulse bg-accent' : 'bg-accent'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <button className="block max-w-full truncate text-left text-sm font-medium text-fg hover:text-accent" onClick={() => setSelected(selected === task.id ? null : task.id)}>
                      {task.name}
                    </button>
                    <p className="mt-0.5 text-xs text-muted">
                      {triggerLabel(task.trigger, t)}
                      {task.enabled && task.nextRunAt ? ` · ${t('tasks.next')} ${new Date(task.nextRunAt).toLocaleString(i18n.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                      {` · ${t('tasks.month')} ${money.format(task.monthCost)}`}
                    </p>
                    {task.lastResult?.summary && (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed break-words text-fg/85">
                        <span className="text-subtle">{t(`tasks.status.${task.lastResult.status}`)} · </span>
                        {task.lastResult.summary}
                      </p>
                    )}
                  </div>
                  <Switch checked={task.enabled} aria-label={task.name} onCheckedChange={() => void toggle(task)} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1 pl-5">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!task.enabled || settings?.tasks.paused || status === 'running'}
                    onClick={() =>
                      void api.tasks
                        .run(task.id)
                        .then(() => setSelected(task.id))
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    <Play />
                    {t('tasks.run')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(task)}>
                    <Pencil />
                    {t('tasks.edit')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(selected === task.id ? null : task.id)}>
                    <History />
                    {t('tasks.records')}
                  </Button>
                  <Tip label={t('common.delete')}>
                    <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={t('common.delete')} onClick={() => void remove(task)}>
                      <Trash2 />
                    </Button>
                  </Tip>
                </div>
                {selected === task.id && (
                  <ol className="mt-3 space-y-2.5 border-t border-border/70 pt-3" data-testid="task-runs">
                    {runs.length === 0 && <li className="text-xs text-muted">{t('tasks.noRuns')}</li>}
                    {runs.map((r) => (
                      <li key={r.id} className="text-xs text-fg">
                        <p className="text-muted tabular-nums">
                          {new Date(r.startedAt).toLocaleString(i18n.language)} · {r.delayed && `${t('tasks.delayed')} · `}
                          {t(`tasks.status.${r.status}`)} · {money.format(r.cost)}
                        </p>
                        {r.summary && <p className="mt-1 leading-relaxed break-words">{r.summary}</p>}
                        {r.error && <p className="mt-1 text-danger">{r.error}</p>}
                        {r.resultRefs.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            {r.resultRefs.map((ref, i) => (
                              <button
                                key={i}
                                className="text-accent hover:underline"
                                onClick={() => {
                                  useApp.getState().setSettingsOpen(false)
                                  if (ref.type === 'proposal' || ref.type === 'note') useApp.getState().openNote(ref.noteId ?? ref.id)
                                  else useApp.getState().goNav(ref.type === 'inbox' ? 'inbox' : 'today')
                                }}
                              >
                                {t(`tasks.output.${ref.type === 'proposal' ? 'note' : ref.type === 'action' ? 'actions' : ref.type}`)}
                              </button>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}
