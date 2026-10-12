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
  if (!state || settingsOpen || state.status !== 'ready' || state.mode !== 'automatic' || dismissed === state.nextVersion) return null
  return (
    <aside
      data-testid="update-restart-notice"
      aria-live="polite"
      className="fixed right-5 bottom-5 z-30 w-[min(360px,calc(100vw-40px))] rounded-xl border border-border bg-surface p-4 text-sm shadow-float"
    >
      <p>{t('updates.readyNotice', { version: state.nextVersion })}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void api.updates.install().catch(() => useApp.getState().openSettings('updates'))}>
          {t('updates.restart')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(state.nextVersion ?? null)}>
          {t('updates.later')}
        </Button>
      </div>
    </aside>
  )
}
