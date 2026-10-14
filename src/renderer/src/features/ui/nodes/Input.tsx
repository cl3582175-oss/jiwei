import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { UiNode } from '@shared/ui/catalog'
import { cn } from '@/lib/utils'
import type { UiContext } from '../context'
import { canReply, sendUiReply } from '../reply'
import { uiAction } from '../ConfirmSheet'

export function ChoiceNode({
  node,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'choice' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const { t } = useTranslation()
  const state = ctx.states[uiKey] ?? {},
    selected = (state.selected ?? []) as string[]
  const local = ctx.context === 'note'
  const locked = disabled || (!local && (!canReply(ctx) || !!state.sent))
  const send = (values: string[]): void => {
    try {
      sendUiReply(
        ctx,
        node,
        uiKey,
        'choose',
        node.options
          .filter((o) => values.includes(o.value))
          .map((o) => o.label)
          .join('、'),
        node.multi ? { values } : { value: values[0] }
      )
      ctx.setState(uiKey, { selected: values, sent: true }, true)
    } catch (e) {
      toast.error(String(e))
    }
  }
  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-sm">{node.question}</p>
      <div role="group" aria-label={node.question} className="flex flex-wrap gap-2">
        {(node.options ?? []).map((o) =>
          node.multi ? (
            <label key={o.value} className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm">
              <input
                type="checkbox"
                className="accent-accent"
                aria-label={o.label}
                checked={selected.includes(o.value)}
                disabled={locked}
                onChange={(e) =>
                  ctx.setState(uiKey, { selected: e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value) })
                }
              />
              <span>
                {o.label}
                {o.hint && <small className="ml-1 text-subtle">{o.hint}</small>}
              </span>
            </label>
          ) : (
            <button
              key={o.value}
              type="button"
              disabled={locked}
              aria-pressed={selected.includes(o.value)}
              className={cn(
                'rounded-full border border-border px-3.5 py-1.5 text-sm hover:border-accent disabled:cursor-default disabled:opacity-60',
                selected.includes(o.value) && 'border-accent bg-accent/10'
              )}
              onClick={() => (local ? ctx.setState(uiKey, { selected: [o.value] }) : send([o.value]))}
            >
              {o.label}
              {o.hint && <small className="ml-1 text-subtle">{o.hint}</small>}
            </button>
          )
        )}
      </div>
      {node.multi && !local && (
        <button className={uiAction} disabled={locked || !selected.length} onClick={() => send(selected)}>
          {t('ui.chooseConfirm')}
        </button>
      )}
      {!local && !ctx.isLatest && <p className="text-2xs text-subtle">{t('ui.latestOnly')}</p>}
    </div>
  )
}

export function FormNode({
  node,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'form' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const { t } = useTranslation()
  const state = ctx.states[uiKey] ?? {},
    fields = node.fields ?? []
  const values = Object.fromEntries(
    fields.map((f) => [
      f.key,
      (state.values as Record<string, unknown> | undefined)?.[f.key] ??
        f.value ??
        (f.kind === 'toggle' ? false : f.kind === 'slider' ? (f.min ?? 0) : '')
    ])
  )
  const local = ctx.context === 'note',
    locked = disabled || (!local && (!canReply(ctx) || !!state.sent))
  const valid = fields.every((f) => {
    const value = values[f.key]
    if (value === '' || value === null || value === undefined) return !f.required
    if (f.kind === 'number' || f.kind === 'slider')
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (f.min === undefined || value >= f.min) &&
        (f.max === undefined || value <= f.max)
      )
    if (f.kind === 'select') return f.options?.some((o) => o.value === value)
    return typeof value === 'boolean' || (typeof value === 'string' && (!f.required || !!value.trim()))
  })
  const update = (key: string, value: unknown): void => ctx.setState(uiKey, { values: { ...values, [key]: value } })
  const submit = (): void => {
    if (!valid || locked) return
    try {
      sendUiReply(ctx, node, uiKey, 'submit', fields.map((f) => `${f.label}：${values[f.key]}`).join('\n'), values)
      ctx.setState(uiKey, { values, sent: true }, true)
    } catch (e) {
      toast.error(String(e))
    }
  }
  const inputClass = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm disabled:opacity-60'
  return (
    <form
      className="space-y-3 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {fields.map((f) => (
        <label key={f.key} className="block text-xs">
          <span className="mb-1 block text-muted">
            {f.label}
            {f.required ? ' *' : ''}
          </span>
          {f.kind === 'select' ? (
            <select
              aria-label={f.label}
              className={inputClass}
              disabled={locked}
              value={String(values[f.key])}
              onChange={(e) => update(f.key, e.target.value)}
            >
              <option value="">{f.placeholder ?? '—'}</option>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.kind === 'toggle' ? (
            <input
              type="checkbox"
              aria-label={f.label}
              className="accent-accent"
              disabled={locked}
              checked={!!values[f.key]}
              onChange={(e) => update(f.key, e.target.checked)}
            />
          ) : (
            <input
              aria-label={f.label}
              className={inputClass}
              disabled={locked}
              type={f.kind === 'slider' ? 'range' : f.kind === 'date' ? 'date' : f.kind === 'number' ? 'number' : 'text'}
              min={f.min}
              max={f.max}
              step={f.step ?? (f.kind === 'number' ? 'any' : undefined)}
              maxLength={2000}
              placeholder={f.placeholder}
              value={String(values[f.key])}
              onChange={(e) =>
                update(
                  f.key,
                  (f.kind === 'number' || f.kind === 'slider') && e.target.value !== '' ? e.target.valueAsNumber : e.target.value
                )
              }
            />
          )}
          {f.kind === 'slider' && <output className="mt-1 block text-sm tabular-nums">{String(values[f.key])}</output>}
        </label>
      ))}
      {!local && (
        <button type="submit" className={uiAction} disabled={locked || !valid}>
          {node.submitLabel ?? t('ui.action.submit')}
        </button>
      )}
      {!local && !ctx.isLatest && <p className="text-2xs text-subtle">{t('ui.latestOnly')}</p>}
    </form>
  )
}
