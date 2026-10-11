import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FileUp, RefreshCw, Rss, Trash2 } from 'lucide-react'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/primitives'
import { tintFor, type Tint } from '@/lib/tint'
import { errText } from '../chat/useChat'
import { field, PlanDialog, TintPicker } from './ui'

// 订阅日历（只读 ICS）：已订阅的列在上面（开关、刷新、删除），下面添加新的订阅或导入 .ics 文件。

export function IcsDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const { data: feeds = [], refetch } = useQuery({ queryKey: ['plan', 'ics'], queryFn: () => api.plan.icsFeeds() })
  const [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [color, setColor] = useState<Tint>('sky'),
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
  const add = (): void =>
    void perform(async () => {
      await api.plan.icsSave({ name, url, color })
      setName('')
      setUrl('')
    })
  return (
    <PlanDialog
      title={t('plan.subscribe')}
      description={t('plan.icsHint')}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void perform(() => api.plan.icsImport())}>
            <FileUp />
            {t('plan.importIcs')}
          </Button>
          <Button variant="primary" size="sm" className="ml-auto" disabled={busy || !name.trim() || !url.trim()} onClick={add}>
            <Rss />
            {t('plan.feedAdd')}
          </Button>
        </>
      }
    >
      {feeds.length > 0 && (
        <ul className="divide-y divide-border/70 rounded-xl border border-border/70" data-testid="ics-feeds">
          {feeds.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2.5" data-tint={tintFor(f.id, f.color)}>
              <span className="size-2.5 shrink-0 rounded-full bg-[var(--tint-ink)]" />
              <div className="min-w-0 flex-1">
                <p className={cn('truncate text-sm', f.enabled ? 'text-fg' : 'text-subtle')}>{f.name}</p>
                <p className={cn('truncate text-2xs', f.error ? 'text-danger' : 'text-subtle')}>
                  {f.error ?? (f.lastFetchedAt ? new Date(f.lastFetchedAt).toLocaleString(i18n.language) : t('plan.fetchPending'))}
                </p>
              </div>
              {!f.url.startsWith('file:') && (
                <Tip label={t('plan.refresh')}>
                  <Button size="icon-sm" variant="ghost" aria-label={t('plan.refresh')} disabled={busy} onClick={() => void perform(() => api.plan.icsRefresh(f.id))}>
                    <RefreshCw className={cn(busy && 'animate-spin')} />
                  </Button>
                </Tip>
              )}
              <Tip label={t('common.delete')}>
                <Button size="icon-sm" variant="ghost" aria-label={t('common.delete')} disabled={busy} onClick={() => void perform(() => api.plan.icsRemove(f.id))}>
                  <Trash2 />
                </Button>
              </Tip>
              <Switch
                checked={f.enabled}
                disabled={busy}
                aria-label={f.name}
                onCheckedChange={(enabled) =>
                  void perform(() => api.plan.icsSave({ id: f.id, name: f.name, url: f.url, color: f.color as Tint, enabled }))
                }
              />
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-[1fr_2fr] gap-3">
        <label className="block text-xs text-muted">
          {t('plan.feedName')}
          <input className={field} value={name} placeholder={t('plan.feedNamePh')} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-xs text-muted">
          {t('plan.feedUrl')}
          <input className={field} value={url} placeholder="https://… / webcal://…" onChange={(e) => setUrl(e.target.value)} />
        </label>
      </div>
      <div className="text-xs text-muted">
        {t('plan.color')}
        <TintPicker value={color} onChange={setColor} label={t('plan.color')} />
      </div>
    </PlanDialog>
  )
}
