import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { TINTS } from '@/lib/tint'
import { errText } from '../chat/useChat'
import { field, PlanDialog } from './ui'

export function IcsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { data: feeds = [], refetch } = useQuery({ queryKey: ['plan', 'ics'], queryFn: () => api.plan.icsFeeds() })
  const [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [color, setColor] = useState<(typeof TINTS)[number]>('sky'),
    [busy, setBusy] = useState(false)
  const perform = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await refetch()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <PlanDialog title={t('plan.subscribe')} onClose={onClose}>
      <p className="text-xs text-muted">{t('plan.icsHint')}</p>
      <label className="block text-xs text-muted">
        {t('plan.feedName')}
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block text-xs text-muted">
        {t('plan.feedUrl')}
        <input className={field} value={url} placeholder="https://… / webcal://…" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="block text-xs text-muted">
        {t('plan.color')}
        <select className={field} value={color} onChange={(e) => setColor(e.target.value as typeof color)}>
          {TINTS.map((c) => (
            <option key={c} value={c}>
              {t(`tints.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <Button
          disabled={busy || !name.trim() || !url.trim()}
          onClick={() =>
            void perform(async () => {
              await api.plan.icsSave({ name, url, color })
              setName('')
              setUrl('')
            })
          }
        >
          {t('plan.feedAdd')}
        </Button>
        <Button disabled={busy} onClick={() => void perform(() => api.plan.icsImport())}>
          {t('plan.importIcs')}
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {feeds.map((f) => (
          <li key={f.id} className="py-3 text-sm text-fg">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void perform(() =>
                      api.plan.icsSave({ id: f.id, name: f.name, url: f.url, color: f.color as typeof color, enabled: e.target.checked })
                    )
                  }
                />
                {f.name}
              </label>
              {!f.url.startsWith('file:') && (
                <Button size="sm" disabled={busy} onClick={() => void perform(() => api.plan.icsRefresh(f.id))}>
                  {t('plan.refresh')}
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => void perform(() => api.plan.icsRemove(f.id))}>
                {t('common.delete')}
              </Button>
            </div>
            <p className="mt-1 truncate text-2xs text-subtle">
              {f.lastFetchedAt ? new Date(f.lastFetchedAt).toLocaleString() : t('plan.fetchPending')}
            </p>
            {f.error && <p className="text-xs text-danger">{f.error}</p>}
          </li>
        ))}
      </ul>
      <Button variant="ghost" onClick={onClose}>
        {t('common.close')}
      </Button>
    </PlanDialog>
  )
}
