import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface ConfirmItem {
  id: string
  label: string
  detail?: string
}
export function ConfirmSheet({
  items,
  target,
  onConfirm,
  onCancel
}: {
  items: ConfirmItem[]
  target: string
  onConfirm(ids: string[]): Promise<void>
  onCancel(): void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(() => new Set(items.map((i) => i.id))),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <div data-testid="ui-confirm" className="m-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
      <p className="text-sm font-medium">{t('ui.confirm.title')}</p>
      <p className="mt-1 text-xs text-muted">{target}</p>
      <ul className="my-3 space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                disabled={busy}
                checked={selected.has(item.id)}
                onChange={(e) =>
                  setSelected((old) => {
                    const next = new Set(old)
                    if (e.target.checked) next.add(item.id)
                    else next.delete(item.id)
                    return next
                  })
                }
              />
              <span>
                {item.label}
                {item.detail && <small className="mt-0.5 block text-subtle">{item.detail}</small>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="rounded-lg bg-accent px-3 py-1.5 text-xs text-on-accent disabled:opacity-40"
          disabled={busy || !selected.size}
          onClick={() => {
            setBusy(true)
            setError('')
            void onConfirm([...selected])
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false))
          }}
        >
          {t('ui.confirm.ok')}
        </button>
        <button disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={onCancel}>
          {t('ui.confirm.cancel')}
        </button>
      </div>
    </div>
  )
}
