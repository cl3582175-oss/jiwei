import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { PluginInfo, PluginPreview } from '@shared/plugins'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { PlanDialog } from '../plan/ui'
import { PluginConfirmDialog, PluginConfigFields, PluginOriginLabel, pluginConfigPatch, pluginError } from './PluginConfirmDialog'

/** P2 的市场获取也应把主进程预览交给同一个确认组件。 */
export function PluginFileInstallButton() {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [preview, setPreview] = useState<PluginPreview | null>(null),
    [current, setCurrent] = useState<PluginInfo>()
  const open = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const p = await api.plugins.installFromFile()
      if (p) {
        setCurrent((await api.plugins.list()).find((x) => x.id === p.id))
        setPreview(p)
      }
    } catch (e) {
      setError(pluginError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button disabled={busy} onClick={() => void open()}>
        {t('plugins.fromFile')}
      </Button>
      {busy && (
        <p role="status" className="text-xs text-muted">
          {t('plugins.preparing')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {preview && (
        <PluginConfirmDialog
          key={preview.token}
          preview={preview}
          current={current}
          onClose={() => setPreview(null)}
          onInstalled={() => {
            setPreview(null)
            toast.success(t('plugins.done'))
          }}
        />
      )}
    </>
  )
}
function InstalledPlugin({ plugin: p }: { plugin: PluginInfo }) {
  const { t } = useTranslation()
  const selected = useApp((s) => s.settingsPluginId)
  const ref = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<PluginPreview | null>(null)
  const [removing, setRemoving] = useState(false),
    [removeFeeds, setRemoveFeeds] = useState(false),
    [removeTasks, setRemoveTasks] = useState(false)
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
  return (
    <article
      ref={ref}
      data-plugin-id={p.id}
      className={`space-y-3 rounded-xl border p-4 [overflow-wrap:anywhere] ${selected === p.id ? 'border-accent' : 'border-border'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate font-medium" title={p.id}>
          {p.manifest.displayName ?? p.manifest.name}
        </h3>
        <span className="text-xs text-muted">
          {p.version} · {t(p.enabled ? 'plugins.enabled' : 'plugins.disabled')}
        </span>
        <PluginOriginLabel origin={p.origin} />
      </div>
      <p className="text-xs text-muted">{p.manifest.description}</p>
      <p className="text-xs text-muted">{t('plugins.retained', { feeds: p.feeds, tasks: p.tasks })}</p>
      {!p.available && <p className="text-xs text-danger">{t('plugins.unavailable')}</p>}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" disabled={busy || !p.available} onClick={() => void run(() => api.plugins.setEnabled(p.id, !p.enabled))}>
          {t(p.enabled ? 'plugins.disable' : 'plugins.enable')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void run(async () => setPreview(await api.plugins.update(p.id)))}>
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
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {preview && (
        <PluginConfirmDialog
          key={preview.token}
          preview={preview}
          current={p}
          onClose={() => setPreview(null)}
          onInstalled={() => {
            setPreview(null)
            toast.success(t('plugins.done'))
          }}
        />
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
  const { data: list = [], isPending, error } = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list() })
  return (
    <section className="space-y-4" data-testid="plugins-settings">
      <h2 className="font-serif text-lg">
        {t('plugins.title')} · {t('plugins.installed')}
      </h2>
      <PluginFileInstallButton />
      {isPending && <p role="status">…</p>}
      {error && (
        <p role="alert" className="text-danger">
          {pluginError(error)}
        </p>
      )}
      {!isPending && !list.length && <p className="text-sm text-muted">{t('plugins.empty')}</p>}
      {list.map((p) => (
        <InstalledPlugin key={p.id} plugin={p} />
      ))}
    </section>
  )
}
