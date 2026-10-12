import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useUpdates } from './useUpdates'

export function UpdateNotice() {
  const { data: state } = useUpdates(),
    { t } = useTranslation(),
    settingsOpen = useApp((s) => s.settingsOpen),
    [dismissed, setDismissed] = useState<string | null>(null)
  const restart = state?.status === 'ready' && state.mode === 'automatic',
    available = state && state.mode !== 'automatic' && state.mode !== 'disabled' && ['available', 'ready'].includes(state.status)
  if (!state || settingsOpen || (!restart && !available) || dismissed === state.nextVersion) return null
  return (
    <aside
      data-testid={restart ? 'update-restart-notice' : 'update-available-notice'}
      aria-live="polite"
      className="fixed right-5 bottom-5 z-30 w-[min(360px,calc(100vw-40px))] rounded-xl border border-border bg-surface p-4 text-sm shadow-float"
    >
      <p>{t(restart ? 'updates.readyNotice' : 'updates.available', { version: state.nextVersion })}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            restart
              ? void api.updates.install().catch(() => useApp.getState().openSettings('updates'))
              : useApp.getState().openSettings('updates')
          }
        >
          {t(restart ? 'updates.restart' : 'updates.view')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(state.nextVersion ?? null)}>
          {t('updates.later')}
        </Button>
      </div>
    </aside>
  )
}
