import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { PluginMarketInfo, PluginCatalogCard } from '@shared/plugins'
import { api } from '@/lib/utils'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { PlanDialog, field } from '../plan/ui'
import { PluginOriginLabel, pluginError } from './PluginConfirmDialog'
import { PluginInstallButtons, usePluginAcquisition } from './PluginAcquisition'
import { Tip } from '@/components/ui/primitives'
import { RefreshCw, X } from 'lucide-react'
import { PluginIcon } from './PluginDetailsDialog'

export function PluginUpdateDot() {
  const { t } = useTranslation()
  // 只读主进程持久缓存，不调用刷新或下载。
  const { data = [] } = useQuery({ queryKey: ['plugins', 'catalog'], queryFn: () => api.plugins.catalog() })
  return data.some((p) => p.updateAvailable) ? (
    <span aria-label={t('plugins.hasUpdate')} title={t('plugins.hasUpdate')} className="ml-auto size-1.5 rounded-full bg-accent" />
  ) : null
}
export function PluginMarketplace({ onInstalledDetails }: { onInstalledDetails: (id: string) => void }) {
  const { t, i18n } = useTranslation()
  const { data: settings } = useSettings(),
    updateSettings = useUpdateSettings()
  const markets = useQuery({ queryKey: ['plugins', 'markets'], queryFn: () => api.plugins.markets() })
  const catalog = useQuery({ queryKey: ['plugins', 'catalog'], queryFn: () => api.plugins.catalog() })
  const acquisition = usePluginAcquisition()
  const [market, setMarket] = useState(''),
    [category, setCategory] = useState('')
  const [search, setSearch] = useState(''),
    [debounced, setDebounced] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [add, setAdd] = useState(false),
    [kind, setKind] = useState<'github' | 'url'>('github'),
    [input, setInput] = useState(''),
    [trust, setTrust] = useState(false)
  const [removing, setRemoving] = useState<PluginMarketInfo>(),
    [uninstall, setUninstall] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 150)
    return () => clearTimeout(timer)
  }, [search])
  // 每次进入只触发一次 stale 检查；失败事件使查询失效也不会再次自动刷新。
  useEffect(() => {
    let mounted = true
    setBusy(true)
    void api.plugins
      .refreshMarket(undefined, true)
      .catch((e) => {
        if (mounted) setError(pluginError(e))
      })
      .finally(() => {
        if (mounted) setBusy(false)
      })
    return () => {
      mounted = false
    }
  }, [])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(pluginError(e))
    } finally {
      setBusy(false)
    }
  }
  const local = (card: PluginCatalogCard, field: 'Name' | 'Description') => {
    const value = card[`localized${field}`]
    return value ? (i18n.language.startsWith('zh') ? value.zh : value.en) : field === 'Name' ? card.displayName : card.description
  }
  const cards = (catalog.data ?? []).filter(
    (p) =>
      (!market || p.origin.market === market) &&
      (!category || p.category === category) &&
      [
        p.name,
        p.displayName,
        p.description,
        ...p.keywords,
        p.localizedName?.zh,
        p.localizedName?.en,
        p.localizedDescription?.zh,
        p.localizedDescription?.en
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(debounced.trim().toLocaleLowerCase())
  )
  const locked = busy || acquisition.active
  const ctl = 'h-[34px] rounded-lg border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent'
  const added = new Set((markets.data ?? []).map((m) => m.name))
  const recommended = [
    { repo: 'anthropics/knowledge-work-plugins', market: 'knowledge-work-plugins' },
    { repo: 'anthropics/skills', market: 'anthropic-agent-skills' }
  ].filter((r) => !added.has(r.market))
  const lastFetched = Math.max(0, ...(markets.data ?? []).map((m) => m.fetchedAt ?? 0))
  const chosen = markets.data?.find((m) => m.name === market)
  return (
    <div className="space-y-4" data-testid="plugin-marketplace">
      {/* 一行工具栏：搜索为主，筛选与市场管理靠右 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${ctl} min-w-48 flex-1`}
          aria-label={t('plugins.search')}
          placeholder={t('plugins.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label={t('plugins.category')} className={ctl} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t('plugins.allCategories')}</option>
          {['role', 'skills', 'templates', 'sources', 'connector', 'renderer'].map((c) => (
            <option key={c} value={c}>
              {t(`plugins.category_${c}`)}
            </option>
          ))}
        </select>
        <select aria-label={t('plugins.allMarkets')} className={ctl} value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">{t('plugins.allMarkets')}</option>
          {markets.data?.map((m) => (
            <option key={m.name} value={m.name}>
              {m.builtin ? t('plugins.official') : m.name}
            </option>
          ))}
        </select>
        <Button
          disabled={locked}
          onClick={() => {
            setInput('')
            setTrust(false)
            setAdd(true)
          }}
        >
          {t('plugins.addMarket')}
        </Button>
        <Tip
          label={lastFetched ? t('plugins.cachedAt', { time: new Date(lastFetched).toLocaleString(i18n.language) }) : t('plugins.refresh')}
        >
          <Button
            size="icon"
            aria-label={t('plugins.refresh')}
            disabled={locked}
            onClick={() => void run(() => api.plugins.refreshMarket(market || undefined))}
          >
            <RefreshCw className={busy ? 'animate-spin' : ''} />
          </Button>
        </Tip>
      </div>
      {!settings?.plugins.recommendedDismissed && recommended.length > 0 && (
        <aside className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-sunken px-4 py-3 text-xs">
          <span className="min-w-0 flex-1 basis-60 text-muted">
            <strong className="font-medium text-fg">{t('plugins.recommend')}</strong> {t('plugins.recommendHint')}
          </span>
          {recommended.map(({ repo }) => (
            <Button
              size="sm"
              key={repo}
              disabled={locked}
              onClick={() => void acquisition.start({ source: { kind: 'github', url: repo } })}
            >
              {repo.split('/')[1]}
            </Button>
          ))}
          <Tip label={t('plugins.dismiss')}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('plugins.dismiss')}
              disabled={updateSettings.isPending}
              onClick={() => void run(() => updateSettings.mutateAsync({ plugins: { recommendedDismissed: true } }))}
            >
              <X />
            </Button>
          </Tip>
        </aside>
      )}
      {/* 市场状态：只在出错，或选中一个第三方市场时显示 */}
      {(markets.data ?? [])
        .filter((m) => m.error || (market === m.name && !m.builtin))
        .map((m) => (
          <section
            data-market-name={m.name}
            key={m.name}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs [overflow-wrap:anywhere]"
          >
            <span className="min-w-0 flex-1">
              <strong className="font-medium">{m.builtin ? t('plugins.official') : m.name}</strong>
              <span className="text-muted">
                {' · '}
                {m.owner} ·{' '}
                {m.fetchedAt
                  ? t('plugins.cachedAt', { time: new Date(m.fetchedAt).toLocaleString(i18n.language) })
                  : t('plugins.neverFetched')}
              </span>
              {m.error && (
                <span role="alert" className="mt-1 block text-danger">
                  {m.error}
                </span>
              )}
            </span>
            {m.error && (
              <Button size="sm" disabled={locked} onClick={() => void run(() => api.plugins.refreshMarket(m.name))}>
                {t('plugins.retry')}
              </Button>
            )}
            {!m.builtin && (
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() => {
                  setRemoving(m)
                  setUninstall(true)
                }}
              >
                {t('plugins.removeMarket')}
              </Button>
            )}
          </section>
        ))}
      {chosen?.count === 0 && <p className="text-sm text-muted">{t('plugins.emptyMarket')}</p>}
      {(markets.isPending || catalog.isPending) && (
        <div role="status" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="h-28 animate-pulse rounded-xl bg-sunken" />
          ))}
        </div>
      )}
      {(error || markets.error || catalog.error) && (
        <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
          {error || pluginError(markets.error ?? catalog.error)}
        </p>
      )}
      {!catalog.isPending && cards.length === 0 && (
        <div className="space-y-2 py-6 text-center text-sm text-muted">
          <p>{t('plugins.noResults')}</p>
          <Button
            size="sm"
            onClick={() => {
              setMarket('')
              setCategory('')
              setSearch('')
            }}
          >
            {t('plugins.clearFilters')}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map((p) => {
          const author = typeof p.author === 'string' ? p.author : p.author?.name
          const official = p.origin.kind === 'market' && markets.data?.some((m) => m.builtin && m.name === p.origin.market)
          const openDetails = () =>
            p.installedVersion
              ? onInstalledDetails(p.id)
              : void acquisition.start({ source: { kind: 'market', market: p.origin.market, name: p.name }, details: true })
          return (
            <article
              key={p.id}
              data-catalog-id={p.id}
              className="flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent/40 [overflow-wrap:anywhere]"
            >
              <button
                className="flex min-w-0 flex-1 gap-3 text-left"
                data-open-details
                title={t('plugins.details')}
                disabled={locked || !p.supported}
                onClick={openDetails}
              >
                <PluginIcon icon={p.icon} name={local(p, 'Name')} category={p.category} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg" title={local(p, 'Name')}>
                    {local(p, 'Name')}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted" title={local(p, 'Description')}>
                    {local(p, 'Description')}
                  </span>
                </span>
              </button>
              {!p.supported && <p className="mt-2 text-xs text-warning">{p.unsupportedReason}</p>}
              <div className="mt-3 flex items-center gap-2">
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-2xs text-muted">
                  <span>{t(`plugins.category_${p.category}`)}</span>
                  <PluginOriginLabel origin={p.origin} />
                  {!official && author && <span className="truncate">{author}</span>}
                  {p.installedVersion && <span>{p.installedVersion}</span>}
                  {p.updateAvailable && <span className="text-accent">{t('plugins.hasUpdate')}</span>}
                  {p.updateUnavailable && <span className="text-warning">{t('plugins.noUpdates')}</span>}
                </span>
                <Button
                  size="sm"
                  variant={p.installedVersion && !p.updateAvailable ? 'ghost' : 'primary'}
                  disabled={locked || !p.supported || (!!p.installedVersion && !p.updateAvailable)}
                  onClick={() =>
                    void acquisition.start(
                      p.installedVersion ? { update: p.id } : { source: { kind: 'market', market: p.origin.market, name: p.name } }
                    )
                  }
                >
                  {t(p.updateAvailable ? 'plugins.updateAction' : p.installedVersion ? 'plugins.installed' : 'plugins.install')}
                </Button>
              </div>
            </article>
          )
        })}
      </div>
      <PluginInstallButtons />
      {add && (
        <PlanDialog
          title={t('plugins.addMarket')}
          testId="plugin-add-market"
          onClose={() => {
            if (!busy) setAdd(false)
          }}
          footer={
            <div className="ml-auto flex gap-2">
              <Button disabled={busy} onClick={() => setAdd(false)}>
                {t('plugins.cancel')}
              </Button>
              <Button
                disabled={busy || !input.trim() || (kind === 'url' && !trust)}
                onClick={() => {
                  if (kind === 'github') {
                    setAdd(false)
                    void acquisition.start({ source: { kind: 'github', url: input.trim() } })
                  } else
                    void run(async () => {
                      await api.plugins.addMarket({ kind: 'url', url: input.trim() })
                      setAdd(false)
                    })
                }}
              >
                {t(kind === 'url' ? 'plugins.trustAccept' : 'plugins.continue')}
              </Button>
            </div>
          }
        >
          <select
            className={field}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as 'github' | 'url')
              setTrust(false)
            }}
          >
            <option value="github">GitHub</option>
            <option value="url">HTTPS</option>
          </select>
          <label className="block text-sm">
            {t(kind === 'github' ? 'plugins.github' : 'plugins.url')}
            <input
              className={field}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setTrust(false)
              }}
            />
          </label>
          {kind === 'url' && (
            <label className="flex gap-2 text-sm text-warning">
              <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
              <span>
                {input}
                <br />
                {t('plugins.trustUrl', {
                  host: (() => {
                    try {
                      return new URL(input).host
                    } catch {
                      return input || 'HTTPS'
                    }
                  })()
                })}
              </span>
            </label>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              setAdd(false)
              void acquisition.start({ file: true })
            }}
          >
            {t('plugins.localMarket')}
          </Button>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <p className="text-xs text-muted">{t('plugins.sourceHelp')}</p>
        </PlanDialog>
      )}
      {removing && (
        <PlanDialog
          title={t('plugins.removeMarket')}
          description={t('plugins.removeMarketHint')}
          testId="plugin-remove-market"
          onClose={() => {
            if (!busy) setRemoving(undefined)
          }}
          footer={
            <div className="ml-auto flex gap-2">
              <Button disabled={busy} onClick={() => setRemoving(undefined)}>
                {t('plugins.cancel')}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.plugins.removeMarket(removing.name, { uninstall })
                    setRemoving(undefined)
                    if (market === removing.name) setMarket('')
                  })
                }
              >
                {t('plugins.removeMarket')}
              </Button>
            </div>
          }
        >
          <p>{removing.name}</p>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" checked={uninstall} onChange={(e) => setUninstall(e.target.checked)} />
            {t('plugins.uninstallMarketPlugins')}
          </label>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </PlanDialog>
      )}
      {acquisition.dialog}
    </div>
  )
}
