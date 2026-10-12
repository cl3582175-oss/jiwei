import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, ChevronRight, Download, Loader2, RefreshCw } from 'lucide-react'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { Switch } from '@/components/ui/switch'
import { useSettings } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import type { UpdateState } from '@shared/updates'
import { useUpdates } from './useUpdates'
import { UpdateNotes } from './UpdateNotes'

/** “macOS · Apple 芯片”这类人能看懂的平台说明 */
function platformLabel(state: Pick<UpdateState, 'platform' | 'arch'>, t: (k: string) => string): string {
  const os = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[state.platform] ?? state.platform
  const arch =
    state.platform === 'darwin'
      ? state.arch === 'arm64'
        ? t('updates.appleSilicon')
        : t('updates.intel')
      : state.arch === 'x64'
        ? t('updates.bit64')
        : state.arch
  return `${os} · ${arch}`
}

/** 设置 →「关于」：应用信息、软件更新、许可与出品方 */
export function AboutSettings() {
  const { t } = useTranslation(),
    { data: state } = useUpdates(),
    { data: settings } = useSettings()
  const [feed, setFeed] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    setFeed(settings?.updates?.feedUrl ?? '')
  }, [settings?.updates?.feedUrl])
  if (!state) return null
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch {
      setError(t('updates.errors.server'))
    } finally {
      setBusy(false)
    }
  }
  const retry = async () => {
    await api.updates.check()
    const current = await api.updates.status()
    if (current.mode === 'mac-manual' && current.status === 'available') await api.updates.download()
  }
  const save = async () => {
    try {
      await api.settings.set({ updates: { feedUrl: feed.trim() } })
      setError('')
    } catch {
      setError(t('updates.sourceInvalid'))
    }
  }
  const notesUrl = `https://github.com/cl3582175-oss/jiwei-releases/releases/tag/v${state.nextVersion ?? state.version}`
  const disabled = state.mode === 'disabled'
  const checking = state.status === 'checking'
  const failure = error || (state.error ? t(`updates.errors.${state.error}`) : '')
  const statusText = disabled
    ? t('updates.disabled')
    : checking
      ? t('updates.checking')
      : state.status === 'downloading'
        ? t('updates.downloading', { percent: Math.round(state.percent ?? 0) })
        : state.status === 'ready'
          ? t('updates.ready')
          : state.status === 'current'
            ? t('updates.current')
            : state.nextVersion
              ? t('updates.available', { version: state.nextVersion })
              : t('updates.idle')
  const StatusIcon = failure
    ? AlertCircle
    : checking
      ? Loader2
      : state.status === 'current' || state.status === 'ready'
        ? CheckCircle2
        : state.nextVersion
          ? Download
          : RefreshCw
  return (
    <section data-testid="update-settings" className="mx-auto max-w-[560px] min-w-0 space-y-5 pb-2 [overflow-wrap:anywhere]">
      <header className="flex flex-col items-center pt-2 text-center">
        <Logo size={56} />
        <h3 className="mt-4 font-serif text-xl font-semibold tracking-widest text-fg">{t('app.name')}</h3>
        <p className="mt-1 text-sm text-muted">{t('app.slogan')}</p>
        <p className="mt-3 text-xs text-subtle tabular-nums">
          {t('settings.version')} {state.version} · {platformLabel(state, t)}
        </p>
      </header>

      {state.upgrade && (
        <div className="rounded-xl border border-accent/30 bg-accent-soft p-4 text-sm">
          <p className="font-medium text-fg">{t('updates.upgraded', { version: state.upgrade.to })}</p>
          {state.upgrade.backupName && (
            <p className="mt-1 text-xs text-muted">{t('updates.snapshot', { from: state.upgrade.from, to: state.upgrade.to })}</p>
          )}
          {state.upgrade.backupFailed && (
            <p role="alert" className="mt-1 text-xs text-danger">
              {t('updates.backupFailed')}
            </p>
          )}
          <div className="mt-2 -ml-2 flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" onClick={() => void run(() => api.updates.openLink(notesUrl))}>
              {t('updates.fullNotes')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void run(() => api.updates.acknowledge())}>
              {t('updates.dismiss')}
            </Button>
          </div>
        </div>
      )}

      <div className="divide-y divide-border rounded-xl border border-border">
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-3">
            <StatusIcon
              className={cn(
                'size-5 shrink-0',
                failure ? 'text-danger' : state.nextVersion && state.status !== 'current' ? 'text-accent' : 'text-subtle',
                checking && 'animate-spin'
              )}
            />
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-medium text-fg">{t('updates.section')}</h4>
              <p role="status" className="text-xs text-muted">
                {statusText}
              </p>
            </div>
            {!disabled && !['downloading', 'ready'].includes(state.status) && (
              <Button size="sm" variant="outline" disabled={busy || checking} onClick={() => void run(() => api.updates.check())}>
                {t('updates.check')}
              </Button>
            )}
          </div>
          {failure && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
              <span className="min-w-0 flex-1">{failure}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(retry)}>
                {t('updates.retry')}
              </Button>
            </div>
          )}
          {state.status === 'available' && state.mode === 'mac-manual' && (
            <Button variant="primary" disabled={busy} onClick={() => void run(() => api.updates.download())}>
              <Download />
              {t('updates.download')}
            </Button>
          )}
          {state.mode === 'download-page' && state.nextVersion && (
            <div className="space-y-2 text-sm">
              <p className="text-xs text-muted">{t('updates.packageOnly')}</p>
              <Button variant="primary" onClick={() => void run(() => api.updates.openLink())}>
                {t('updates.downloadPage')}
              </Button>
            </div>
          )}
          {state.status === 'downloading' && (
            <div
              className="h-1.5 overflow-hidden rounded-full bg-sunken"
              role="progressbar"
              aria-valuenow={Math.round(state.percent ?? 0)}
              aria-label={t('updates.downloading', { percent: Math.round(state.percent ?? 0) })}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.max(3, state.percent ?? 0)}%` }}
              />
            </div>
          )}
          {state.status === 'ready' && state.mode === 'mac-manual' && (
            <div data-testid="update-replace-guide" className="space-y-2 rounded-lg bg-sunken p-3 text-sm">
              <p>{t('updates.replace')}</p>
              <p className="text-xs text-muted">{t('updates.replaceWarning')}</p>
              <Button variant="primary" disabled={busy} onClick={() => void run(() => api.updates.install())}>
                {t('updates.openQuit')}
              </Button>
            </div>
          )}
          {state.status === 'ready' && state.mode === 'automatic' && (
            <Button variant="primary" disabled={busy} onClick={() => void run(() => api.updates.install())}>
              {t('updates.restartButton')}
            </Button>
          )}
        </div>

        {state.notes && (
          <div className="p-4">
            <h4 className="text-sm font-medium">{t('updates.notes')}</h4>
            <div className="mt-1 max-h-64 overflow-y-auto">
              <UpdateNotes text={state.notes} />
            </div>
            {state.notesTruncated && <p className="text-xs text-muted">{t('updates.truncated')}</p>}
            <Button size="sm" variant="ghost" className="mt-1 -ml-2" onClick={() => void run(() => api.updates.openLink(notesUrl))}>
              {t('updates.fullNotes')}
            </Button>
          </div>
        )}

        {!disabled && (
          <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
            <span>{t('updates.auto')}</span>
            <Switch
              aria-label={t('updates.auto')}
              checked={settings?.updates?.autoCheck ?? true}
              onCheckedChange={(autoCheck) => void run(() => api.settings.set({ updates: { autoCheck } }))}
            />
          </label>
        )}

        {!disabled && (
          <details className="group px-4 py-3 text-sm">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-muted hover:text-fg">
              <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
              {t('updates.source')}
            </summary>
            <p className="mt-2 text-xs text-muted">{t('updates.sourceHint')}</p>
            <div className="mt-2 flex gap-2">
              <Input
                aria-label={t('updates.source')}
                className="min-w-0 flex-1"
                placeholder="https://"
                value={feed}
                onChange={(event) => setFeed(event.target.value)}
              />
              <Button size="sm" variant="outline" onClick={() => void save()}>
                {t('updates.save')}
              </Button>
            </div>
          </details>
        )}
      </div>

      <footer className="space-y-1 text-center text-xs leading-relaxed text-subtle">
        <p>{t('settings.licenseDesc')}</p>
        <p data-testid="about-maker">{t('updates.maker')}</p>
      </footer>
    </section>
  )
}
