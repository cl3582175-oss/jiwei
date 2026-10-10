import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, FolderOpen, Download, RotateCcw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { api, formatBytes } from '@/lib/utils'
import type { BackupManifest, BackupPreview } from '@shared/backup'
import { SafetyProgress, safetyMessage } from './SafetyProgress'

const time = (at: number | null | undefined): string => (at ? new Date(at).toLocaleString() : i18n.t('safety.never'))
const recordingPrivacy = (manifest: BackupManifest): string => {
  const audio = manifest.files.filter((f) => f.path.startsWith('recordings/') && /\.webm(?:\.enc)?$/.test(f.path))
  if (!audio.length) return i18n.t('safety.preview.noAudio')
  const encrypted = audio.filter((f) => f.path.endsWith('.enc')).length
  return i18n.t(encrypted === audio.length ? 'safety.preview.allEncrypted' : encrypted ? 'safety.preview.someEncrypted' : 'safety.preview.plain')
}
export function BackupSettings() {
  const { t } = useTranslation()
  const qc = useQueryClient(),
    [preview, setPreview] = useState<BackupPreview | null>(null),
    [includeProfile, setIncludeProfile] = useState(true),
    [restoreProfile, setRestoreProfile] = useState(false),
    [mode, setMode] = useState<'new' | 'replace'>('new'),
    [busy, setBusy] = useState(false)
  const { data: status } = useQuery({ queryKey: ['backup-status'], queryFn: () => api.backups.status(), refetchInterval: 1000 })
  const { data: backups = [] } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.backups.list(),
    refetchInterval: busy ? 1000 : false
  })
  const running = busy || status?.progress.state === 'running'
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['backups'] })
    void qc.invalidateQueries({ queryKey: ['backup-status'] })
  }
  const action = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      refresh()
    } catch (e) {
      toast.error(safetyMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const select = async (name?: string): Promise<void> => {
    await action(async () => {
      const p = await api.backups.preview(name)
      if (p) {
        setPreview(p)
        setRestoreProfile(p.profileEmpty && p.manifest.includeProfile)
        setMode('new')
      }
    })
  }
  const restore = async (): Promise<void> => {
    if (!preview) return
    if (
      mode === 'replace' &&
      !(await confirm({
        title: t('safety.backup.replaceTitle'),
        description: t('safety.backup.replaceDesc'),
        danger: true,
        confirmText: t('safety.backup.replaceOk')
      }))
    )
      return
    if (
      restoreProfile &&
      !preview.profileEmpty &&
      !(await confirm({
        title: t('safety.backup.profileTitle'),
        description: t('safety.backup.profileDesc'),
        danger: true,
        confirmText: t('safety.backup.profileOk')
      }))
    )
      return
    await action(async () => {
      const result = await api.backups.restore({
        token: preview.token,
        mode,
        includeProfile: restoreProfile,
        confirmed: mode === 'replace'
      })
      if (result) {
        setPreview(null)
        void qc.invalidateQueries()
      }
    })
  }
  return (
    <section className="safety-ui space-y-5 py-5 text-sm" data-testid="backup-settings">
      <div>
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="size-5 text-accent" />
          {t('safety.backup.title')}
        </h3>
        <p className="mt-2 leading-relaxed text-muted">
          {t('safety.backup.desc')}
        </p>
      </div>
      {status?.notice && (
        <p className="rounded-lg bg-warning/10 p-3 text-warning" role="status">
          {status.notice}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border p-4">
        <div className="col-span-2">
          <dt className="text-xs text-muted">{t('safety.backup.lastLocal')}</dt>
          <dd className="mt-1">{time(status?.localAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('safety.backup.bytes')}</dt>
          <dd className="mt-1">{formatBytes(status?.bytes ?? 0)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('safety.backup.lastExternal')}</dt>
          <dd className="mt-1">{time(status?.externalAt)}</dd>
        </div>
      </dl>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={includeProfile}
          disabled={running}
          onChange={(e) => setIncludeProfile(e.target.checked)}
          className="size-4 accent-accent"
        />
        {t('safety.backup.includeProfile')}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={running} onClick={() => void action(() => api.backups.create(includeProfile))}>
          <Archive />
          {t('safety.backup.now')}
        </Button>
        <Button variant="outline" disabled={running} onClick={() => void action(() => api.backups.export(includeProfile))}>
          <Download />
          {t('safety.backup.export')}
        </Button>
        <Button variant="outline" disabled={running} onClick={() => void select()}>
          <RotateCcw />
          {t('safety.backup.restore')}
        </Button>
        <Button variant="ghost" onClick={() => void api.backups.reveal()}>
          <FolderOpen />
          {t('safety.backup.reveal')}
        </Button>
      </div>
      {status && <SafetyProgress value={status.progress} cancel={() => void api.backups.cancel()} />}
      {status?.restoredVault && status.progress.state === 'done' && (
        <div className="rounded-xl border border-accent/30 bg-accent-soft p-4">
          <p>{t('safety.backup.restored', { name: status.restoredVault.name })}</p>
          <Button variant="outline" className="mt-3" onClick={() => void api.vaults.switch(status.restoredVault!.id)}>
            {t('safety.backup.switchRestored')}
          </Button>
        </div>
      )}
      <div className="space-y-3 border-t border-border pt-5">
        <h4 className="font-medium">{t('safety.backup.externalTitle')}</h4>
        <p className="text-xs leading-relaxed text-muted">
          {t('safety.backup.externalDesc')}
        </p>
        <p className="break-all text-sm text-muted">{status?.external.path ?? t('safety.backup.externalNone')}</p>
        {status?.externalUnavailable && (
          <p className="text-warning" role="status">
            {t('safety.backup.externalUnavailable', { time: time(status.externalAt) })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={running}
            onClick={() =>
              void action(async () => {
                const path = await api.backups.pickExternal()
                if (path)
                  await api.settings.set({
                    backup: { external: { path, frequency: status?.external.frequency ?? 'weekly', keep: status?.external.keep ?? 4 } }
                  })
              })
            }
          >
            {t('safety.backup.pickFolder')}
          </Button>
          <select
            aria-label={t('safety.backup.frequency')}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            disabled={!status?.external.path || running}
            value={status?.external.frequency ?? 'weekly'}
            onChange={(e) =>
              void action(() =>
                api.settings.set({ backup: { external: { ...status!.external, frequency: e.target.value as 'daily' | 'weekly' } } })
              )
            }
          >
            <option value="daily">{t('safety.backup.daily')}</option>
            <option value="weekly">{t('safety.backup.weekly')}</option>
          </select>
          <label className="flex items-center gap-2 text-xs text-muted">
            {t('safety.backup.keep')}
            <input
              aria-label={t('safety.backup.keepLabel')}
              type="number"
              min={1}
              max={100}
              className="w-16 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-fg"
              defaultValue={status?.external.keep ?? 4}
              key={status?.external.keep}
              onBlur={(e) => {
                const keep = Number(e.target.value)
                if (status && Number.isInteger(keep) && keep >= 1 && keep <= 100)
                  void action(() => api.settings.set({ backup: { external: { ...status.external, keep } } }))
              }}
            />
          </label>
          {status?.external.path && (
            <Button
              variant="ghost"
              onClick={() => void action(() => api.settings.set({ backup: { external: { ...status.external, path: null } } }))}
            >
              {t('safety.backup.disableExternal')}
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-3 border-t border-border pt-5">
        <h4 className="font-medium">{t('safety.backup.history')}</h4>
        {!backups.length ? (
          <p className="rounded-xl bg-sunken p-4 text-muted">{t('safety.backup.empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {backups.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div>
                  <p>{time(b.createdAt)}</p>
                  <p className="mt-1 text-xs text-muted">
                    {t(`safety.backup.kinds.${b.kind}`)} · {t(b.format === 'snapshot' ? 'safety.backup.snapshot' : 'safety.backup.database')} · {formatBytes(b.size)}
                  </p>
                </div>
                {b.format === 'snapshot' && (
                  <Button variant="ghost" disabled={running} onClick={() => void select(b.name)}>
                    {t('safety.backup.restoreThis')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {t('safety.backup.archiveNote')}
      </p>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open && !running) setPreview(null)
        }}
      >
        <DialogContent
          title={t('safety.preview.title')}
          description={t('safety.preview.desc')}
          className="safety-ui max-h-[86vh] w-[min(92vw,560px)] overflow-y-auto"
        >
          {preview && (
            <div className="mt-5 space-y-5 text-sm" data-testid="restore-preview">
              <div className="rounded-xl border border-border p-4">
                <p className="font-medium">{preview.manifest.vault}</p>
                <p className="mt-1 text-xs text-muted">
                  {time(preview.manifest.createdAt)} · {preview.manifest.device}
                </p>
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <p>{t('safety.preview.notes', { count: preview.manifest.notes })}</p>
                  <p>{t('safety.preview.sources', { count: preview.manifest.sources })}</p>
                  <p>{t('safety.preview.recordings', { count: preview.manifest.recordings })}</p>
                </div>
                <p className="mt-3 text-muted">
                  {formatBytes(preview.manifest.totalSize)} · {t(preview.manifest.includeProfile ? 'safety.preview.withProfile' : 'safety.preview.withoutProfile')} ·{' '}
                  {recordingPrivacy(preview.manifest)}
                </p>
              </div>
              <fieldset className="space-y-3" disabled={running}>
                <legend className="mb-3 font-medium">{t('safety.preview.mode')}</legend>
                <label className="flex gap-3 rounded-xl border border-accent/40 bg-accent-soft p-4">
                  <input
                    type="radio"
                    name="restore-mode"
                    className="mt-1 size-4 accent-accent"
                    checked={mode === 'new'}
                    onChange={() => setMode('new')}
                  />
                  <span>
                    <span className="block font-medium">{t('safety.preview.asNew')}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted">
                      {t('safety.preview.asNewHint')}
                    </span>
                  </span>
                </label>
                <label className="flex gap-3 rounded-xl border border-border p-4">
                  <input
                    type="radio"
                    name="restore-mode"
                    className="mt-1 size-4 accent-accent"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                  />
                  <span>
                    <span className="block text-danger">{t('safety.preview.replace')}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted">{t('safety.preview.replaceHint')}</span>
                  </span>
                </label>
              </fieldset>
              {preview.manifest.includeProfile && (
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-accent"
                    checked={restoreProfile}
                    disabled={running}
                    onChange={(e) => setRestoreProfile(e.target.checked)}
                  />
                  <span>
                    {t('safety.preview.profile')}
                    <span className="mt-1 block text-xs leading-relaxed text-muted">
                      {t(preview.profileEmpty ? 'safety.preview.profileEmpty' : 'safety.preview.profileReplace')}
                    </span>
                  </span>
                </label>
              )}
              <p className="text-xs leading-relaxed text-muted">{t('safety.preview.moveNote')}</p>
              {status && running && <SafetyProgress value={status.progress} cancel={() => void api.backups.cancel()} />}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={running} onClick={() => setPreview(null)}>
                  {t('safety.preview.cancel')}
                </Button>
                <Button variant="primary" disabled={running} onClick={() => void restore()}>
                  {t('safety.preview.confirm')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
