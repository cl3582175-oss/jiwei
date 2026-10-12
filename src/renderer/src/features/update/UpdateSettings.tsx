import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { Switch } from '@/components/ui/switch'
import { useSettings } from '@/lib/queries'
import { api } from '@/lib/utils'
import { useUpdates } from './useUpdates'
import { UpdateNotes } from './UpdateNotes'

export function UpdateSettings() {
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
  return (
    <section data-testid="update-settings" className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
      <div className="flex items-center gap-3">
        <Logo size={44} />
        <div>
          <h3 className="font-serif text-lg text-fg">{t('app.name')}</h3>
          <p className="text-sm text-muted">
            {state.version} · {state.platform} · {state.arch}
          </p>
        </div>
      </div>
      {state.upgrade && (
        <div className="rounded-lg border border-accent/30 bg-accent-soft p-3 text-sm">
          <p>{t('updates.upgraded', { version: state.upgrade.to })}</p>
          {state.upgrade.backupName && (
            <p className="mt-1 text-xs text-muted">{t('updates.snapshot', { from: state.upgrade.from, to: state.upgrade.to })}</p>
          )}
          {state.upgrade.backupFailed && (
            <p role="alert" className="mt-1">
              {t('updates.backupFailed')}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => void run(() => api.updates.openLink(notesUrl))}>
              {t('updates.fullNotes')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void run(() => api.updates.acknowledge())}>
              {t('updates.dismiss')}
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || state.mode === 'disabled' || state.status === 'checking' || state.status === 'downloading'}
          onClick={() => void run(() => api.updates.check())}
        >
          {state.status === 'checking' && <Loader2 className="animate-spin" />}
          {t('updates.check')}
        </Button>
        <p role="status" className="text-sm text-muted">
          {state.mode === 'disabled'
            ? t('updates.disabled')
            : state.status === 'checking'
              ? t('updates.checking')
              : state.status === 'current'
                ? t('updates.current')
                : state.nextVersion
                  ? t('updates.available', { version: state.nextVersion })
                  : t('updates.idle')}
        </p>
      </div>
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>{t('updates.auto')}</span>
        <Switch
          aria-label={t('updates.auto')}
          checked={settings?.updates?.autoCheck ?? true}
          onCheckedChange={(autoCheck) => void run(() => api.settings.set({ updates: { autoCheck } }))}
        />
      </label>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">{t('updates.source')}</summary>
        <p className="mt-2 text-xs text-muted">{t('updates.sourceHint')}</p>
        <Input aria-label={t('updates.source')} className="mt-2 w-full" value={feed} onChange={(event) => setFeed(event.target.value)} />
        <Button className="mt-2" size="sm" variant="outline" onClick={() => void save()}>
          {t('updates.save')}
        </Button>
      </details>
      {(error || state.error) && (
        <div role="alert" className="space-y-2 text-sm text-fg">
          <p>{error || t(`updates.errors.${state.error}`)}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(retry)}>
            {t('updates.retry')}
          </Button>
        </div>
      )}
      {state.status === 'available' && state.mode === 'mac-manual' && (
        <Button disabled={busy} onClick={() => void run(() => api.updates.download())}>
          {t('updates.download')}
        </Button>
      )}
      {state.mode === 'download-page' && state.nextVersion && (
        <div className="space-y-2 text-sm">
          <p>{t('updates.packageOnly')}</p>
          <Button onClick={() => void run(() => api.updates.openLink())}>{t('updates.downloadPage')}</Button>
        </div>
      )}
      {state.status === 'downloading' && (
        <div className="space-y-2">
          <p className="text-sm text-muted">{t('updates.downloading', { percent: Math.round(state.percent ?? 0) })}</p>
          <progress
            className="h-2 w-full accent-accent"
            max={100}
            value={state.percent ?? 0}
            aria-label={t('updates.downloading', { percent: Math.round(state.percent ?? 0) })}
          />
        </div>
      )}
      {state.status === 'ready' && state.mode === 'mac-manual' && (
        <div data-testid="update-replace-guide" className="space-y-3 rounded-xl border border-border bg-sunken p-4 text-sm">
          <p>{t('updates.replace')}</p>
          <p className="text-muted">{t('updates.replaceWarning')}</p>
          <Button disabled={busy} onClick={() => void run(() => api.updates.install())}>
            {t('updates.openQuit')}
          </Button>
        </div>
      )}
      {state.status === 'ready' && state.mode === 'automatic' && (
        <div className="space-y-2 text-sm">
          <p>{t('updates.ready')}</p>
          <Button disabled={busy} onClick={() => void run(() => api.updates.install())}>
            {t('updates.restartButton')}
          </Button>
        </div>
      )}
      {state.notes && (
        <div className="border-t border-border pt-3">
          <h4 className="font-semibold">{t('updates.notes')}</h4>
          <UpdateNotes text={state.notes} />
          {state.notesTruncated && <p className="text-xs text-muted">{t('updates.truncated')}</p>}
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => void run(() => api.updates.openLink(notesUrl))}>
            {t('updates.fullNotes')}
          </Button>
        </div>
      )}
    </section>
  )
}
