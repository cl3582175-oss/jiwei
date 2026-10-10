import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import type { Scene } from '@shared/recording'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, Input } from '@/components/ui/primitives'
import { openSeriesPage } from './pages'

export const lensSelectClass =
  'min-w-0 max-w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-accent'
export function SeriesSelect({
  value,
  onChange,
  scene,
  pending = false
}: {
  value: string | null
  onChange: (id: string | null) => void
  scene: Scene
  pending?: boolean
}) {
  const { t } = useTranslation(),
    qc = useQueryClient(),
    [open, setOpen] = useState(false),
    [name, setName] = useState(''),
    [category, setCategory] = useState('')
  const { data: series = [] } = useQuery({ queryKey: ['series'], queryFn: () => api.series.list() }),
    { data: categories = [] } = useQuery({ queryKey: ['categories', 'note'], queryFn: () => api.categories.list('note') })
  const { data: actions = [], refetch } = useQuery({
    queryKey: ['series-actions', value],
    queryFn: () => api.series.openActions(value!),
    enabled: pending && !!value
  })
  const create = async (): Promise<void> => {
    const s = await api.series.save({ name, scene, categoryId: category || null })
    await qc.invalidateQueries({ queryKey: ['series'] })
    onChange(s.id)
    setOpen(false)
    setName('')
  }
  return (
    <div className="space-y-2" data-testid="series-select">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted">
          {t('series.title')}
          <select
            aria-label={t('series.title')}
            className={lensSelectClass + ' flex-1'}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">{t('series.none')}</option>
            {series.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <Plus />
          {t('series.new')}
        </Button>
        {value && (
          <Button size="sm" variant="ghost" onClick={() => openSeriesPage(value)}>
            {t('series.open')}
          </Button>
        )}
      </div>
      {pending && !!actions.length && (
        <section className="rounded-lg bg-sunken p-3" data-testid="series-pending">
          <p className="mb-2 text-xs font-medium">{t('series.pending')}</p>
          {actions.map((a) => (
            <label key={a.id} className="mb-1 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                aria-label={a.title}
                checked={a.status === 'done'}
                onChange={() =>
                  void api.actions
                    .update(a.id, { status: 'done' })
                    .then(() => refetch())
                    .catch((e) => toast.error(String(e)))
                }
              />
              <span>
                {a.title}
                {a.ownerName && ` · ${a.ownerName}`}
              </span>
            </label>
          ))}
        </section>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={t('series.new')}>
          <div className="mt-4 space-y-3">
            <Input aria-label={t('series.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            <label className="flex flex-wrap gap-2 text-xs">
              {t('series.category')}
              <select
                className={lensSelectClass}
                aria-label={t('series.category')}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">{t('notes.uncategorized')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" disabled={!name.trim()} onClick={() => void create().catch((e) => toast.error(String(e)))}>
              {t('common.create')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
