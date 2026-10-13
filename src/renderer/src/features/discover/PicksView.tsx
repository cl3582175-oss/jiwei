import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { localDay } from '@shared/plan'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { FeedItem, DiscoverAction } from '@shared/discover'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useMoney } from '@/lib/money'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/primitives'
import { BookOpen, ChevronDown, Clock, Download, Globe, Sparkles } from 'lucide-react'
import { useDiscoverEvents } from './queries'
import { FeedsDrawer } from './FeedsDrawer'
import { useRetrievalStatus } from '../retrieval/queries'

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
    [busy, setBusy] = useState(false)
  const act = async (action: DiscoverAction['action'], reason?: DiscoverAction['reason']): Promise<void> => {
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
  const host = item.url.startsWith('jiwei:') ? t('discover.knowledge') : new URL(item.url).hostname.replace(/^www\./, '')
  return (
    <article
      data-testid={`pick-${item.id}`}
      className="paper min-w-0 rounded-2xl px-5 py-4 shadow-[var(--shadow-1)] transition-shadow hover:shadow-[var(--shadow-2)]"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-subtle">
        <span className="inline-flex items-center gap-1">
          <Globe className="size-3" />
          {host}
        </span>
        {item.publishedAt && <time className="tabular-nums">{new Date(item.publishedAt).toLocaleDateString(i18n.language)}</time>}
        {item.minutes ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" />
            {t('discover.minutes', { count: item.minutes })}
          </span>
        ) : null}
        {item.remedyId && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">{t('discover.remedy')}</span>}
      </div>
      <h3 className="mt-1.5 font-serif text-[17px] leading-snug font-semibold break-words text-fg">
        <button
          className="max-w-full text-left [overflow-wrap:anywhere] hover:text-accent"
          onClick={() => void act('read')}
          disabled={busy}
        >
          {item.title}
        </button>
      </h3>
      <p className="mt-2.5 flex gap-2 rounded-xl bg-accent-soft/40 px-3 py-2 text-sm leading-relaxed break-words text-fg">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
        {/* flex 子项默认不缩到比最长单词更窄，长链接 / 无空格文本会撑破卡片 */}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="sr-only">{t('discover.why')}：</span>
          {item.reason}
          {item.gap && (
            <span className="text-muted">
              {' '}
              · {t('discover.gap')}：{item.gap}
            </span>
          )}
        </span>
      </p>
      {item.related.length > 0 && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-xs text-subtle">{t('discover.related')}</span>
          {item.related.map((r) => (
            <Related key={`${r.type}:${r.id}`} {...r} />
          ))}
        </div>
      )}
      <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void act('read')}>
          <BookOpen />
          {t('discover.read')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('save')}>
          <Download />
          {t('discover.save')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('later')}>
          <Clock />
          {t('discover.later')}
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" className="ml-auto text-muted" disabled={busy}>
              {t('discover.dismiss')}
              <ChevronDown />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            {(['irrelevant', 'shallow', 'hard', 'untrusted'] as const).map((k) => (
              <MenuItem key={k} onSelect={() => void act('dismiss', k)}>
                {t(`discover.reasons.${k}`)}
              </MenuItem>
            ))}
            <MenuItem onSelect={() => void act('dismiss')}>{t('discover.noReason')}</MenuItem>
          </MenuContent>
        </Menu>
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
    { data: retrieval } = useRetrievalStatus()
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
        {retrieval && !retrieval.webAvailable && (
          <button className="mb-4 text-xs text-accent hover:underline" onClick={() => useApp.getState().openSettings('search')}>
            {t('discover.searchHint')}
          </button>
        )}
        {!visible.length && (
          <div className="py-16 text-center">
            {status?.status === 'ok' && status.date === localDay() && (status.considered ?? 0) > 0 ? (
              <>
                <h2 className="font-serif text-lg">{t('discover.emptyToday')}</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted">{t('discover.emptyTodayHint', { count: status.considered })}</p>
              </>
            ) : (
              <>
                <h2 className="font-serif text-lg">{t('discover.empty')}</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted">{t('discover.emptyHint')}</p>
              </>
            )}
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
