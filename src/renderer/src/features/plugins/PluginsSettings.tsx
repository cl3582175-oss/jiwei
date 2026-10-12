import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { PluginInfo } from '@shared/plugins'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { PlanDialog, Segmented } from '../plan/ui'
import { PluginInstallButtons, usePluginAcquisition } from './PluginAcquisition'
import { PluginDetailsDialog, PluginIcon } from './PluginDetailsDialog'
import { PluginMarketplace } from './PluginMarketplace'
import { PluginConfigFields, PluginOriginLabel, pluginConfigPatch, pluginError } from './PluginConfirmDialog'

export function PluginFileInstallButton() {
  return <PluginInstallButtons fileOnly />
}
function InstalledPlugin({
  plugin: p,
  details,
  setDetails
}: {
  plugin: PluginInfo
  details: boolean
  setDetails: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const selected = useApp((s) => s.settingsPluginId)
  const ref = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const acquisition = usePluginAcquisition()
  const { data: catalog = [] } = useQuery({ queryKey: ['plugins', 'catalog'], queryFn: () => api.plugins.catalog() })
  const card = catalog.find((c) => c.id === p.id && c.origin.locator === p.origin.locator)
  const retained = p.origin.kind === 'market' && !card
  const [removing, setRemoving] = useState(false),
    [removeFeeds, setRemoveFeeds] = useState(false),
    [removeTasks, setRemoveTasks] = useState(false)
  const [clearKey, setClearKey] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  useEffect(() => {
    if (selected === p.id) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected, p.id])
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
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
  const configSection = (
    <>
      {!!Object.keys(p.manifest.userConfig ?? {}).length && (
        <details>
          <summary className="cursor-pointer text-sm">{t('plugins.config')}</summary>
          <div className="mt-3 space-y-3">
            <PluginConfigFields
              manifest={p.manifest}
              values={fields}
              onChange={(k, v) => setFields({ ...fields, [k]: v })}
              presence={p.sensitive}
            />
            {Object.entries(p.manifest.userConfig ?? {})
              .filter(([key]) => p.sensitive[key] || p.config[key] !== undefined)
              .map(([key, f]) => (
                <div key={key} className="text-xs">
                  <span>
                    {f.title} · {t('plugins.configured')}
                  </span>
                  {clearKey === key ? (
                    <div className="space-y-2">
                      <p>{t('plugins.clearConfigHint')}</p>
                      <Button disabled={busy} onClick={() => setClearKey(null)}>
                        {t('plugins.cancel')}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.plugins.setConfig(p.id, { [key]: null })
                            setClearKey(null)
                            setFields({})
                          })
                        }
                      >
                        {t('plugins.clearConfig')}
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" onClick={() => setClearKey(key)}>
                      {t('plugins.clearConfig')}
                    </Button>
                  )}
                </div>
              ))}
            <Button
              size="sm"
              disabled={busy || !Object.values(fields).some(Boolean)}
              onClick={() =>
                void run(async () => {
                  let values
                  try {
                    values = pluginConfigPatch(p.manifest, fields)
                  } catch {
                    throw new Error(t('plugins.configInvalid'))
                  }
                  await api.plugins.setConfig(p.id, values)
                  setFields({})
                })
              }
            >
              {t('plugins.saveConfig')}
            </Button>
          </div>
        </details>
      )}
    </>
  )
  return (
    <article
      ref={ref}
      data-plugin-id={p.id}
      className={`space-y-3 rounded-xl border p-4 [overflow-wrap:anywhere] ${selected === p.id ? 'border-accent' : 'border-border'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <PluginIcon icon={card?.icon} name={p.manifest.displayName ?? p.manifest.name} category={card?.category ?? 'skills'} />
        <h3 className="min-w-0 truncate font-medium" title={p.id}>
          {p.manifest.displayName ?? p.manifest.name}
        </h3>
        <span className="text-xs text-muted">
          {p.version} · {t(p.enabled ? 'plugins.enabled' : 'plugins.disabled')}
        </span>
        <PluginOriginLabel origin={p.origin} />
      </div>
      <p className="text-xs text-muted">{p.manifest.description}</p>
      <p className="text-xs text-muted">
        {typeof p.manifest.author === 'string' ? p.manifest.author : p.manifest.author?.name} ·{' '}
        {t(`plugins.category_${card?.category ?? (p.capabilities.servers.length ? 'connector' : 'skills')}`)}
      </p>
      {card?.updateAvailable && <p className="text-xs text-accent">{t('plugins.hasUpdate')}</p>}
      <p className="text-xs text-muted">{t('plugins.retained', { feeds: p.feeds, tasks: p.tasks })}</p>
      {!p.available && <p className="text-xs text-danger">{t('plugins.unavailable')}</p>}
      {retained && <p className="text-xs text-warning">{t('plugins.noUpdates')}</p>}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" onClick={() => setDetails(true)}>
          {t('plugins.details')}
        </Button>
        <Button size="sm" disabled={busy || !p.available} onClick={() => void run(() => api.plugins.setEnabled(p.id, !p.enabled))}>
          {t(p.enabled ? 'plugins.disable' : 'plugins.enable')}
        </Button>
        <Button size="sm" disabled={busy || retained || acquisition.active} onClick={() => void acquisition.start({ update: p.id })}>
          {t('plugins.updateAction')}
        </Button>
        {p.previousVersion && (
          <Button size="sm" disabled={busy} onClick={() => void run(() => api.plugins.rollback(p.id))}>
            {t('plugins.rollback')} · {p.previousVersion}
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => void run(() => api.plugins.openFolder(p.id))}>
          {t('plugins.openFolder')}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setRemoveFeeds(false)
            setRemoveTasks(false)
            setRemoving(true)
          }}
        >
          {t('plugins.uninstall')}
        </Button>
      </div>
      {!details && configSection}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {acquisition.dialog}
      {details && (
        <PluginDetailsDialog plugin={p} onClose={() => setDetails(false)}>
          {configSection}
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !p.available} onClick={() => void run(() => api.plugins.setEnabled(p.id, !p.enabled))}>
              {t(p.enabled ? 'plugins.disable' : 'plugins.enable')}
            </Button>
            <Button
              disabled={busy || retained}
              onClick={() => {
                setDetails(false)
                void acquisition.start({ update: p.id })
              }}
            >
              {t('plugins.updateAction')}
            </Button>
            {p.previousVersion && (
              <Button disabled={busy} onClick={() => void run(() => api.plugins.rollback(p.id))}>
                {t('plugins.rollback')} · {p.previousVersion}
              </Button>
            )}
            <Button onClick={() => void run(() => api.plugins.openFolder(p.id))}>{t('plugins.openFolder')}</Button>
            <Button
              onClick={() => {
                setDetails(false)
                setRemoveFeeds(false)
                setRemoveTasks(false)
                setRemoving(true)
              }}
            >
              {t('plugins.uninstall')}
            </Button>
          </div>
        </PluginDetailsDialog>
      )}
      {removing && (
        <PlanDialog
          title={t('plugins.uninstall')}
          description={t('plugins.uninstallHint')}
          onClose={() => {
            if (!busy) setRemoving(false)
          }}
          testId="plugin-uninstall"
          footer={
            <div className="ml-auto flex gap-2">
              <Button disabled={busy} onClick={() => setRemoving(false)}>
                {t('plugins.cancel')}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.plugins.uninstall(p.id, { removeFeeds, removeTasks })
                    setRemoving(false)
                  })
                }
              >
                {t('plugins.uninstall')}
              </Button>
            </div>
          }
        >
          <p className="text-sm">
            {p.id} · {t('plugins.retained', { feeds: p.feeds, tasks: p.tasks })}
          </p>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" checked={removeFeeds} onChange={(e) => setRemoveFeeds(e.target.checked)} />
            {t('plugins.removeFeeds')}
          </label>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" checked={removeTasks} onChange={(e) => setRemoveTasks(e.target.checked)} />
            {t('plugins.removeTasks')}
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </PlanDialog>
      )}
    </article>
  )
}
export function PluginsSettings() {
  const { t } = useTranslation()
  const selected = useApp((s) => s.settingsPluginId)
  const [tab, setTab] = useState<'installed' | 'market' | 'roles'>('installed')
  const [detailsId, setDetailsId] = useState<string | null>(null)
  useEffect(() => {
    if (selected) setTab('installed')
  }, [selected])
  const { data: list = [], isPending, error } = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list() })
  return (
    <section className="space-y-4" data-testid="plugins-settings">
      <h2 className="font-serif text-lg">{t('plugins.title')}</h2>
      <Segmented
        label={t('plugins.title')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'installed', label: t('plugins.installed') },
          { value: 'market', label: t('plugins.marketTab') },
          { value: 'roles', label: t('plugins.roles') }
        ]}
      />
      <PluginInstallButtons />
      {tab === 'installed' ? (
        <>
          {isPending && <div role="status" className="h-28 animate-pulse rounded-xl bg-sunken" />}
          {error && (
            <p role="alert" className="text-danger">
              {pluginError(error)}
            </p>
          )}
          {!isPending && !list.length && <p className="text-sm text-muted">{t('plugins.empty')}</p>}
          {list.map((p) => (
            <InstalledPlugin key={p.id} plugin={p} details={detailsId === p.id} setDetails={(open) => setDetailsId(open ? p.id : null)} />
          ))}
        </>
      ) : (
        <PluginMarketplace
          rolesOnly={tab === 'roles'}
          onInstalledDetails={(id) => {
            setDetailsId(id)
            setTab('installed')
          }}
        />
      )}
    </section>
  )
}
