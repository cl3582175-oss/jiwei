import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Settings } from '@shared/types'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
export function CaptureSettings({ settings, save }: { settings: Settings['capture']; save: (capture: Settings['capture']) => void }) {
  const { t } = useTranslation(),
    [quick, setQuick] = useState(settings.quickShortcut),
    [shot, setShot] = useState(settings.screenshotShortcut),
    [recording, setRecording] = useState(settings.recordingShortcut),
    [errors, setErrors] = useState<string[]>([])
  useEffect(() => {
    void api.capture.shortcuts().then(setErrors)
  }, [settings])
  return (
    <section className="space-y-3">
      <h3>{t('capture.title')}</h3>
      <p className="text-xs text-subtle">{t('capture.shortcutHelp')}</p>
      <label className="flex flex-wrap items-center justify-between gap-2">
        {t('capture.quickShortcut')}
        <input
          aria-label={t('capture.quickShortcut')}
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          className="rounded border border-border p-2"
        />
      </label>
      <label className="flex flex-wrap items-center justify-between gap-2">
        {t('capture.screenshotShortcut')}
        <input
          aria-label={t('capture.screenshotShortcut')}
          value={shot}
          onChange={(e) => setShot(e.target.value)}
          className="rounded border border-border p-2"
        />
      </label>
      <label className="flex flex-wrap items-center justify-between gap-2">
        {t('recording.shortcut')}
        <input
          aria-label={t('recording.shortcut')}
          value={recording}
          onChange={(e) => setRecording(e.target.value)}
          className="rounded border border-border p-2"
        />
      </label>
      <Button onClick={() => save({ ...settings, quickShortcut: quick, screenshotShortcut: shot, recordingShortcut: recording })}>
        {t('capture.apply')}
      </Button>
      {errors.length > 0 && <p role="alert">{t('capture.conflict', { keys: errors.join(', ') })}</p>}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings.sourceInfo} onChange={(e) => save({ ...settings, sourceInfo: e.target.checked })} />
        {t('capture.sourceInfo')}
      </label>
      <p className="text-xs text-subtle">{t('capture.sourcePermission')}</p>
    </section>
  )
}
