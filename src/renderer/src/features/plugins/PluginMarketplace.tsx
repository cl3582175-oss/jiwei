import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { PluginMarketInfo, PluginCatalogCard } from '@shared/plugins'
import { api } from '@/lib/utils'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { PlanDialog, field } from '../plan/ui'
import { PluginOriginLabel, pluginError } from './PluginConfirmDialog'
import { usePluginAcquisition } from './PluginAcquisition'
import { PluginIcon } from './PluginDetailsDialog'

export function PluginUpdateDot() {
  const { t } = useTranslation()
  // 只读主进程持久缓存，不调用刷新或下载。
  const { data = [] } = useQuery({ queryKey: ['plugins', 'catalog'], queryFn: () => api.plugins.catalog() })
  return data.some((p) => p.updateAvailable) ? (
    <span aria-label={t('plugins.hasUpdate')} title={t('plugins.hasUpdate')} className="ml-auto size-1.5 rounded-full bg-accent" />
  ) : null
}
export function PluginMarketplace({
  rolesOnly = false,
  onInstalledDetails
}: {
  rolesOnly?: boolean
  onInstalledDetails: (id: string) => void
}) {
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
      (rolesOnly ? p.category === 'role' : !category || p.category === category) &&
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
  return (
    <div className="space-y-4" data-testid="plugin-marketplace">
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={t('plugins.allMarkets')}
          className={`${field} flex-1`}
          value={market}
          onChange={(e) => setMarket(e.target.value)}
        >
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
        <Button disabled={locked} onClick={() => void run(() => api.plugins.refreshMarket(market || undefined))}>
          {t('plugins.refresh')}
        </Button>
      </div>
      {!settings?.plugins.recommendedDismissed && (
        <aside className="space-y-2 rounded-xl border border-border bg-sunken p-3 text-xs">
          <h3 className="font-medium">{t('plugins.recommend')}</h3>
          <p>{t('plugins.recommendHint')}</p>
          <div className="flex flex-wrap gap-2">
            {['anthropics/knowledge-work-plugins', 'anthropics/skills'].map((repo) => (
              <Button
                size="sm"
                key={repo}
                disabled={locked}
                onClick={() => void acquisition.start({ source: { kind: 'github', url: repo } })}
              >
                {repo}
              </Button>
            ))}
            <Button
              size="sm"
              disabled={updateSettings.isPending}
              onClick={() => void run(() => updateSettings.mutateAsync({ plugins: { recommendedDismissed: true } }))}
            >
              {t('plugins.dismiss')}
            </Button>
          </div>
        </aside>
      )}
      {(markets.data ?? [])
        .filter((m) => !market || market === m.name)
        .map((m) => (
          <section
            data-market-name={m.name}
            key={m.name}
            className="space-y-1 rounded-lg border border-border p-3 text-xs [overflow-wrap:anywhere]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>{m.builtin ? t('plugins.official') : m.name}</strong>
              {!m.builtin && (
                <Button
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    setRemoving(m)
                    setUninstall(true)
                  }}
                >
                  {t('plugins.removeMarket')}
                </Button>
              )}
            </div>
            <p className="text-muted">
              {m.owner} ·{' '}
              {m.fetchedAt
                ? t('plugins.cachedAt', { time: new Date(m.fetchedAt).toLocaleString(i18n.language) })
                : t('plugins.neverFetched')}
            </p>
            {m.error && (
              <div role="alert" className="text-danger">
                <p>{m.error}</p>
                <Button size="sm" disabled={locked} onClick={() => void run(() => api.plugins.refreshMarket(m.name))}>
                  {t('plugins.retry')}
                </Button>
              </div>
            )}
            {m.count === 0 && <p className="text-muted">{t('plugins.emptyMarket')}</p>}
          </section>
        ))}
      <input
        className={field}
        aria-label={t('plugins.search')}
        placeholder={t('plugins.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {!rolesOnly && (
        <select aria-label={t('plugins.category')} className={field} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t('plugins.allCategories')}</option>
          {['role', 'skills', 'templates', 'sources', 'connector', 'renderer'].map((c) => (
            <option key={c} value={c}>
              {t(`plugins.category_${c}`)}
            </option>
          ))}
        </select>
      )}
      {(markets.isPending || catalog.isPending) && (
        <div role="status" className="space-y-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-24 animate-pulse rounded-xl bg-sunken" />
          ))}
        </div>
      )}
      {(error || markets.error || catalog.error) && (
        <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
          {error || pluginError(markets.error ?? catalog.error)}
        </p>
      )}
      {!catalog.isPending && cards.length === 0 && (
        <div className="space-y-2 text-sm text-muted">
          <p>{t(rolesOnly && !search && !market ? 'plugins.rolesEmpty' : 'plugins.noResults')}</p>
          <Button
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
      <div className="grid grid-cols-1 gap-3">
        {cards.map((p) => (
          <article
            key={p.id}
            data-catalog-id={p.id}
            className="min-w-0 space-y-3 rounded-xl border border-border p-4 transition-colors hover:bg-surface-hover [overflow-wrap:anywhere]"
          >
            <div className="flex gap-3">
              <PluginIcon icon={p.icon} name={local(p, 'Name')} category={p.category} />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium" title={local(p, 'Name')}>
                  {local(p, 'Name')}
                </h3>
                <p className="line-clamp-2 text-xs text-muted" title={local(p, 'Description')}>
                  {local(p, 'Description')}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted">
              <span>{t(`plugins.category_${p.category}`)}</span>
              <PluginOriginLabel origin={p.origin} />
              <span>{typeof p.author === 'string' ? p.author : p.author?.name}</span>
              <span>{p.installedVersion ? `${t('plugins.installed')} · ${p.installedVersion}` : p.version}</span>
              {p.updateAvailable && <span className="text-accent">{t('plugins.hasUpdate')}</span>}
            </div>
            {p.updateUnavailable && <p className="text-xs text-warning">{t('plugins.noUpdates')}</p>}
            {!p.supported && <p className="text-xs text-warning">{p.unsupportedReason}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={locked || !p.supported}
                onClick={() =>
                  p.installedVersion
                    ? onInstalledDetails(p.id)
                    : void acquisition.start({ source: { kind: 'market', market: p.origin.market, name: p.name }, details: true })
                }
              >
                {t('plugins.details')}
              </Button>
              <Button
                size="sm"
                variant="primary"
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
        ))}
      </div>
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
