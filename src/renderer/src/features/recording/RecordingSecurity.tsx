import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LockKeyhole, Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, Input } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { api } from '@/lib/utils'
import { SafetyProgress, safetyMessage } from '../settings/SafetyProgress'

export function RecoveryCodeDialog({
  open,
  close,
  unlocked = false,
  onDone
}: {
  open: boolean
  close: () => void
  unlocked?: boolean
  onDone?: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient(),
    [code, setCode] = useState(''),
    [group, setGroup] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
      void qc.invalidateQueries({ queryKey: ['recording-crypto'] })
    } catch (e) {
      setError(safetyMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const dismiss = (): void => {
    if (busy) return
    void api.recording.cancelRecovery()
    setCode('')
    setGroup('')
    setError('')
    close()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) dismiss()
      }}
    >
      <DialogContent
        title={t(unlocked ? 'safety.recording.unlockTitle' : 'safety.recording.title')}
        description={
          t(unlocked ? 'safety.recording.unlockDesc' : 'safety.recording.desc')
        }
        className="safety-ui max-h-[86vh] w-[min(92vw,530px)] overflow-y-auto"
      >
        <div className="mt-5 space-y-4 text-sm" data-testid="recovery-code-dialog">
          <p className="rounded-xl bg-warning/10 p-4 leading-relaxed text-warning">
            {t('safety.recording.warning')}
          </p>
          {unlocked ? (
            <>
              <Input
                aria-label={t('safety.recording.codeLabel')}
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('safety.recording.codePlaceholder')}
              />
              <p className="text-xs text-muted">{t('safety.recording.codeHint')}</p>
            </>
          ) : code ? (
            <>
              <p
                className="rounded-xl border border-accent/30 bg-accent-soft p-4 text-center font-mono text-lg leading-relaxed tracking-wider select-text"
                data-testid="generated-recovery-code"
              >
                {code}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(code).then(() => toast.success(t('safety.recording.copied')))}
                >
                  <Copy />
                  {t('safety.recording.copy')}
                </Button>
                <Button variant="outline" onClick={() => void act(() => api.recording.saveRecovery())}>
                  <Download />
                  {t('safety.recording.saveFile')}
                </Button>
              </div>
              <label className="block space-y-2">
                <span>{t('safety.recording.lastGroup')}</span>
                <Input
                  aria-label={t('safety.recording.lastGroupLabel')}
                  value={group}
                  maxLength={4}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder={t('safety.recording.lastGroupPlaceholder')}
                />
              </label>
              <p className="text-xs text-muted">{t('safety.recording.rotateHint')}</p>
            </>
          ) : (
            <p className="leading-relaxed text-muted">{t('safety.recording.generateHint')}</p>
          )}
          {error && (
            <p className="text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={dismiss}>
              {t('safety.recording.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || (unlocked ? !code.trim() : !!code && group.length !== 4)}
              onClick={() =>
                void act(async () => {
                  if (unlocked) {
                    await api.recording.unlock(code)
                    setCode('')
                    close()
                    onDone?.()
                  } else if (!code) setCode(await api.recording.prepareRecovery())
                  else {
                    await api.recording.confirmRecovery(group)
                    setCode('')
                    setGroup('')
                    close()
                    onDone?.()
                  }
                })
              }
            >
              {t(unlocked ? 'safety.recording.unlock' : code ? 'safety.recording.confirm' : 'safety.recording.generate')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
export function RecordingSecurity({ beforeStart = false }: { beforeStart?: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient(),
    [open, setOpen] = useState(false),
    [unlock, setUnlock] = useState(false)
  const { data: status } = useQuery({ queryKey: ['recording-crypto'], queryFn: () => api.recording.cryptoStatus(), refetchInterval: 1000 })
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      void qc.invalidateQueries({ queryKey: ['recording-crypto'] })
    } catch (e) {
      toast.error(safetyMessage(e))
    }
  }
  if (!status || (beforeStart && status.encryption !== 'unset')) return null
  return (
    <section className="safety-ui space-y-3 rounded-xl border border-border bg-surface p-4 text-sm" data-testid="recording-security">
      <h3 className="flex items-center gap-2 font-medium">
        <LockKeyhole className="size-4 text-accent" />
        {t('safety.recording.section')}
        {t(status.encryption === 'unset' ? 'safety.recording.recommended' : status.encryption === 'on' ? 'safety.recording.on' : 'safety.recording.off')}
      </h3>
      <p className="leading-relaxed text-muted">{t('safety.recording.sectionDesc')}</p>
      {!status.available && <p className="text-warning">{status.reason}</p>}
      {status.encryption === 'unset' ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!status.available} onClick={() => setOpen(true)}>
            {t('safety.recording.enable')}
          </Button>
          <Button variant="ghost" onClick={() => void act(() => api.recording.deferEncryption())}>
            {t('safety.recording.defer')}
          </Button>
        </div>
      ) : !status.unlocked ? (
        <Button
          variant="primary"
          onClick={() => {
            setUnlock(true)
            setOpen(true)
          }}
        >
          {t('safety.recording.enterCode')}
        </Button>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status.encryption === 'on' ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setUnlock(false)
                  setOpen(true)
                }}
              >
                {t('safety.recording.rotate')}
              </Button>
              <Button
                variant="ghost"
                disabled={status.progress.state === 'running'}
                onClick={() =>
                  void act(async () => {
                    if (
                      await confirm({
                        title: t('safety.recording.disableTitle'),
                        description: t('safety.recording.disableDesc'),
                        danger: true,
                        confirmText: t('safety.recording.disableOk')
                      })
                    )
                      await api.recording.encryption(false, true)
                  })
                }
              >
                {t('safety.recording.disable')}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              disabled={!status.available || status.progress.state === 'running'}
              onClick={() => {
                setUnlock(false)
                setOpen(true)
              }}
            >
              {t('safety.recording.enable')}
            </Button>
          )}
          {status.progress.state === 'canceled' || status.progress.state === 'failed' ? (
            <Button variant="outline" onClick={() => void act(() => api.recording.resumeMigration())}>
              {t('safety.recording.resume')}
            </Button>
          ) : null}
        </div>
      )}
      <SafetyProgress value={status.progress} pause cancel={() => void api.recording.pauseMigration()} />
      <RecoveryCodeDialog open={open} unlocked={unlock} close={() => setOpen(false)} />
    </section>
  )
}
