import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { FeedItem, DiscoverAction } from '@shared/discover'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useMoney } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { useDiscoverEvents } from './queries'
import { FeedsDrawer } from './FeedsDrawer'

function Related({ type, id }: { type: 'note' | 'source'; id: string }) {
  const { data } = useQuery<{ title: string } | null>({
    queryKey: ['discover', 'related', type, id],
    queryFn: () => (type === 'note' ? api.notes.get(id) : api.sources.get(id))
  })
  if (!data) return null
  return (
    <button
      className="max-w-full truncate text-xs text-accent hover:underline"
      onClick={() => (type === 'note' ? useApp.getState().openNote(id) : useApp.getState().openSource(id))}
    >
      {data.title}
    </button>
  )
}
function PickCard({ item }: { item: FeedItem }) {
  const { t, i18n } = useTranslation(),
    [busy, setBusy] = useState(false),
    [reason, setReason] = useState<DiscoverAction['reason']>()
  const act = async (action: DiscoverAction['action']): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.discover.act({ itemId: item.id, action, ...(action === 'dismiss' && reason ? { reason } : {}) })
      if (action === 'read') {
        if (r.target?.type === 'note') useApp.getState().openNote(r.target.id)
        else if (r.target?.type === 'source') useApp.getState().openSource(r.target.id)
        else useApp.getState().openBrowser(r.url)
      }
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <article data-testid={`pick-${item.id}`} className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
        <span>{item.url.startsWith('jiwei:') ? t('discover.knowledge') : new URL(item.url).hostname}</span>
        {item.publishedAt && <time>{new Date(item.publishedAt).toLocaleDateString(i18n.language)}</time>}
        <span>{t('discover.minutes', { count: item.minutes ?? 0 })}</span>
        {item.remedyId && <span className="rounded bg-accent-soft px-2 py-0.5 text-accent">{t('discover.remedy')}</span>}
      </div>
      <h3 className="mt-2 break-words font-serif text-base font-semibold">{item.title}</h3>
      <p className="mt-2 break-words text-sm leading-relaxed text-fg">
        <span className="font-medium text-accent">{t('discover.why')}：</span>
        {item.reason}
      </p>
      {item.gap && (
        <p className="mt-1 break-words text-xs text-muted">
          {t('discover.gap')}：{item.gap}
        </p>
      )}
      {item.related.length > 0 && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-xs text-subtle">{t('discover.related')}</span>
          {item.related.map((r) => (
            <Related key={`${r.type}:${r.id}`} {...r} />
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void act('read')}>
          {t('discover.read')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('save')}>
          {t('discover.save')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('later')}>
          {t('discover.later')}
        </Button>
        <div className="ml-auto flex min-w-0 flex-wrap gap-1">
          <select
            className="max-w-full rounded-lg border border-border bg-surface px-2 text-xs"
            aria-label={t('discover.reason')}
            value={reason ?? ''}
            onChange={(e) => setReason((e.target.value as DiscoverAction['reason']) || undefined)}
          >
            <option value="">{t('discover.reason')}</option>
            {(['irrelevant', 'shallow', 'hard', 'untrusted'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`discover.reasons.${k}`)}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('dismiss')}>
            {t('discover.dismiss')}
          </Button>
        </div>
      </div>
    </article>
  )
}
export function PicksView({ inboxIds }: { inboxIds: Set<string> }) {
  const { t } = useTranslation(),
    money = useMoney(),
    [showFeeds, setShowFeeds] = useState(false)
  useDiscoverEvents()
  const { data: items = [] } = useQuery({ queryKey: ['discover', 'items'], queryFn: () => api.discover.items() }),
    { data: status } = useQuery({ queryKey: ['discover', 'status'], queryFn: () => api.discover.status() }),
    { data: providers = [] } = useQuery({ queryKey: ['discover', 'search'], queryFn: () => api.discover.searchProviders() })
  const visible = items.filter((i) => i.inboxId && inboxIds.has(i.inboxId))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10" data-testid="picks-view">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 text-xs text-muted">
            {status && (
              <>
                <span>
                  {t(`discover.status.${status.status}`)} · {t('discover.spent', { cost: money.format(status.spent) })}
                </span>
                {status.message && <p className="mt-1 text-warning">{status.message}</p>}
                {!status.dedupAvailable && <p className="mt-1">{t('discover.dedupHint')}</p>}
              </>
            )}
          </div>
          <Button variant="outline" onClick={() => setShowFeeds(true)}>
            {t('discover.feeds')}
          </Button>
          <Button
            variant="primary"
            disabled={status?.status === 'running'}
            onClick={() => void api.discover.runNow().catch((e: Error) => toast.error(e.message))}
          >
            {t('discover.run')}
          </Button>
        </div>
        {!providers.some((p) => p.enabled && p.keySet) && (
          <button className="mb-4 text-xs text-accent hover:underline" onClick={() => useApp.getState().openSettings('connections')}>
            {t('discover.searchHint')}
          </button>
        )}
        {!visible.length && (
          <div className="py-16 text-center">
            <h2 className="font-serif text-lg">{t('discover.empty')}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">{t('discover.emptyHint')}</p>
          </div>
        )}
        <div className="space-y-3">
          {visible.map((i) => (
            <PickCard key={i.id} item={i} />
          ))}
        </div>
      </div>
      {showFeeds && <FeedsDrawer close={() => setShowFeeds(false)} />}
    </div>
  )
}
