import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Dialog as D } from 'radix-ui'
import { toast } from 'sonner'
import type { FeedInput, Feed } from '@shared/discover'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { confirm } from '@/components/ui/confirm'
import { useDiscoverEvents } from './queries'
const field = 'mt-1 w-full min-w-0 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-fg'
export function FeedsDrawer({ close }: { close: () => void }) {
  const { t, i18n } = useTranslation()
  useDiscoverEvents()
  const { data: feeds = [] } = useQuery({ queryKey: ['discover', 'feeds'], queryFn: () => api.discover.feeds() }),
    { data: goals = [] } = useQuery({ queryKey: ['goals'], queryFn: () => api.goals.list() })
  const [draft, setDraft] = useState<FeedInput>({ url: '', enabled: true, goalId: null }),
    [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  const save = (): void => {
    void run(async () => {
      await api.discover.feedSave(draft)
      setDraft({ url: '', enabled: true, goalId: null })
    })
  }
  const remove = (f: Feed): void => {
    void run(async () => {
      if (await confirm({ title: t('discover.removeFeed'), description: f.title, danger: true })) await api.discover.feedRemove(f.id)
    })
  }
  return (
    <D.Root open onOpenChange={(v) => !v && close()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <D.Content
          className="fixed inset-y-0 right-0 z-50 w-[min(95vw,580px)] overflow-y-auto border-l border-border bg-surface p-6 shadow-float"
          data-testid="feeds-drawer"
        >
          <div className="flex items-center justify-between gap-3">
            <D.Title className="font-serif text-lg">{t('discover.feeds')}</D.Title>
            <Button variant="ghost" onClick={close}>
              {t('discover.close')}
            </Button>
          </div>
          <D.Description className="mt-2 text-xs text-muted">{t('discover.feedHint')}</D.Description>
          <div className="mt-5 space-y-3 rounded-xl bg-sunken p-4">
            <label className="block text-xs text-muted">
              {t('discover.feedUrl')}
              <input
                className={field}
                aria-label={t('discover.feedUrl')}
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                {t('discover.feedKind')}
                <select
                  className={field}
                  aria-label={t('discover.feedKind')}
                  value={draft.kind ?? ''}
                  onChange={(e) => setDraft({ ...draft, kind: (e.target.value as FeedInput['kind']) || undefined })}
                >
                  <option value="">{t('discover.auto')}</option>
                  {(['rss', 'atom', 'arxiv', 'youtube', 'podcast', 'web'] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(`discover.kinds.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                {t('discover.direction')}
                <select
                  className={field}
                  aria-label={t('discover.direction')}
                  value={draft.goalId ?? ''}
                  onChange={(e) => setDraft({ ...draft, goalId: e.target.value || null })}
                >
                  <option value="">{t('discover.noDirection')}</option>
                  {goals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-xs text-muted">
              {t('discover.feedTitle')}
              <input
                className={field}
                aria-label={t('discover.feedTitle')}
                value={draft.title ?? ''}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <Button variant="primary" disabled={busy || !draft.url.trim()} onClick={save}>
              {t(draft.id ? 'common.save' : 'discover.feedAdd')}
            </Button>
          </div>
          <div className="mt-4 space-y-3">
            {feeds.map((f) => (
              <article key={f.id} className="min-w-0 rounded-xl border border-border p-4" data-testid={`feed-${f.id}`}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-sm font-medium">{f.title}</h3>
                    <p className="mt-1 break-all text-xs text-subtle">{f.url}</p>
                    <p className="mt-1 text-xs text-muted">
                      {f.lastFetchedAt
                        ? t('discover.fetched', { time: new Date(f.lastFetchedAt).toLocaleString(i18n.language) })
                        : t('discover.never')}
                    </p>
                    {f.error && <p className="mt-1 text-xs text-danger">{f.error}</p>}
                  </div>
                  <Switch
                    aria-label={`${t('discover.enabled')} ${f.title}`}
                    checked={f.enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) => void run(() => api.discover.feedSave({ ...f, enabled }))}
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || !f.enabled} onClick={() => void run(() => api.discover.feedRefresh(f.id))}>
                    {t('discover.refresh')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(f)}>
                    {t('common.edit')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(f)}>
                    {t('common.delete')}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
