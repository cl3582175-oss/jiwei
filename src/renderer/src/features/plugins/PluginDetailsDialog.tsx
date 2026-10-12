import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { PluginInfo, PluginPreview } from '@shared/plugins'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { tintFor } from '@/lib/tint'
import { Button } from '@/components/ui/button'
import { PlanDialog } from '../plan/ui'
import { PluginOriginLabel, pluginError } from './PluginConfirmDialog'
import { externalPluginUrl, PluginReadme } from './PluginReadme'

export function PluginIcon({ icon, name, category }: { icon?: string; name: string; category: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <span
      data-tint={tintFor(category)}
      className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-[var(--tint)] text-lg text-[var(--tint-ink)]"
    >
      {icon && !failed ? (
        <img
          src={icon}
          alt=""
          className="size-full object-contain"
          onError={() => {
            setFailed(true)
          }}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  )
}
export function PluginDetailsDialog({
  plugin,
  preview,
  onClose,
  onInstall,
  children
}: {
  plugin?: PluginInfo
  preview?: PluginPreview
  onClose: () => void
  onInstall?: () => void
  children?: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const info = plugin ?? preview!
  const query = useQuery({
    queryKey: ['plugins', 'details', plugin?.id ?? preview?.token],
    queryFn: () => api.plugins.details(plugin ? { id: plugin.id } : { token: preview!.token })
  })
  const { data: catalog = [] } = useQuery({ queryKey: ['plugins', 'catalog'], queryFn: () => api.plugins.catalog() })
  const sourceCard = catalog.find((p) => p.id === info.id && p.origin.locator === info.origin.locator)
  const sourceUrl = sourceCard?.sourceUrl
  const originLink =
    externalPluginUrl(sourceUrl) ??
    externalPluginUrl(query.data?.sourceUrl) ??
    externalPluginUrl(info.origin.locator) ??
    (info.origin.kind === 'github' ? externalPluginUrl(`https://github.com/${info.origin.locator}`) : undefined)
  const navigate = (kind: string) => {
    onClose()
    const app = useApp.getState()
    if (kind === 'templates' || kind === 'frameworks') {
      app.setSettingsOpen(false)
      app.setView(kind === 'templates' ? 'works' : 'advisor')
    } else
      app.openSettings(
        kind === 'skills'
          ? 'skills'
          : kind === 'lenses'
            ? 'lenses'
            : kind === 'mcp'
              ? 'connections'
              : kind === 'feeds'
                ? 'discover'
                : 'tasks'
      )
  }
  const c = info.capabilities
  return (
    <PlanDialog
      title={info.manifest.displayName ?? info.manifest.name}
      description={`${t('plugins.version')} ${info.version}`}
      size="lg"
      onClose={onClose}
      testId="plugin-details"
      footer={
        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={onClose}>{t('plugins.close')}</Button>
          {onInstall && (
            <Button variant="primary" onClick={onInstall}>
              {t('plugins.install')}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex items-center gap-3">
        <PluginIcon
          icon={query.data?.icon}
          name={info.manifest.displayName ?? info.manifest.name}
          category={sourceCard?.category ?? ('category' in info ? (info.category ?? 'skills') : 'skills')}
        />
        <div className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
          <p className="text-fg">{info.manifest.description}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <PluginOriginLabel origin={info.origin} />
            {sourceCard?.origin.market !== 'jiwei' && (
              <span>{typeof info.manifest.author === 'string' ? info.manifest.author : info.manifest.author?.name}</span>
            )}
          </p>
        </div>
      </div>
      {plugin?.origin.kind === 'market' && !sourceCard && <p className="text-sm text-warning">{t('plugins.noUpdates')}</p>}
      {originLink && (
        <a
          className="block text-sm text-accent underline [overflow-wrap:anywhere]"
          href={originLink}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t('plugins.repository')}: {originLink}
        </a>
      )}
      <section className="space-y-2 text-sm [overflow-wrap:anywhere]">
        <h3 className="font-medium">{t('plugins.capabilities')}</h3>
        {c.commands.length > 0 && <p className="text-warning">{t('plugins.commandsRisk')}</p>}
        {c.dataLeavesDevice && <p className="text-warning">{t('plugins.leaves')}</p>}
        {c.cost && <p className="text-warning">{i18n.language.startsWith('zh') ? c.cost.zh : c.cost.en}</p>}
        {!!c.renderers?.length && <p className="text-warning">{t('plugins.rendererRisk')}</p>}
        {!c.servers.length && !c.dataLeavesDevice && !c.cost && !c.renderers?.length && (
          <p data-tint="bamboo" className="text-[var(--tint-ink)]">
            {t('plugins.textOnly')}
          </p>
        )}
        {c.domains.length > 0 && (
          <p>
            {t('plugins.domains')}: {c.domains.join(', ')}
          </p>
        )}
        {c.servers.length > 0 && <p>{t('plugins.mcpDisabled')}</p>}
      </section>
      {query.isPending && <div role="status" className="h-24 animate-pulse rounded-lg bg-sunken" />}
      {query.error && (
        <p role="alert" className="text-danger">
          {pluginError(query.error)}
        </p>
      )}
      {query.data && (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('plugins.contents')}</h3>
            {!plugin && <p className="text-xs text-muted">{t('plugins.notInstalledNavigation')}</p>}
            {Object.entries(query.data.contents)
              .filter(([, items]) => items.length)
              .map(([kind, items]) => (
                <div key={kind} className="flex gap-3 border-b border-border py-2 text-sm last:border-0 [overflow-wrap:anywhere]">
                  <span className="w-20 shrink-0 text-xs text-muted">{t(`plugins.${kind === 'mcp' ? 'servers' : kind}`)}</span>
                  <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
                    {items.map((name, i) =>
                      plugin && kind !== 'starters' ? (
                        <button
                          key={i}
                          className="text-left text-accent hover:underline"
                          onClick={() => navigate(kind === 'lenses' ? 'lenses' : kind)}
                        >
                          {name}
                        </button>
                      ) : (
                        <span key={i}>{name}</span>
                      )
                    )}
                  </span>
                </div>
              ))}
          </section>
          {query.data.unsupported.length > 0 && (
            <details className="text-sm [overflow-wrap:anywhere]">
              <summary>{t('plugins.unsupported')}</summary>
              {query.data.unsupported.map((v, i) => (
                <p key={i}>{v}</p>
              ))}
            </details>
          )}
          <section>
            <h3 className="mb-2 text-sm font-medium">{t('plugins.readme')}</h3>
            {query.data.readme ? <PluginReadme text={query.data.readme} /> : <p className="text-xs text-muted">{t('plugins.noReadme')}</p>}
          </section>
        </>
      )}
      {children}
    </PlanDialog>
  )
}
