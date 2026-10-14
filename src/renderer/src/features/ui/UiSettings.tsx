import { useTranslation } from 'react-i18next'
import type { UiSettings } from '@shared/ui/settings'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/features/plan/ui'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export function UiSettingsControls() {
  const qc = useQueryClient()
  const { t } = useTranslation(),
    { data: settings } = useSettings(),
    update = useUpdateSettings()
  if (!settings) return null
  const ui = settings.ai.ui
  const set = (patch: Partial<UiSettings>): void =>
    update.mutate(
      { ai: { ...settings.ai, ui: { ...ui, ...patch } } },
      {
        onError: (e) => {
          toast.error(String(e))
          void qc.invalidateQueries({ queryKey: ['settings'] })
        }
      }
    )
  return (
    <section data-testid="ui-settings" className="space-y-3">
      <h4 className="text-sm font-medium text-fg">{t('ui.settings.title')}</h4>
      <fieldset className="space-y-3" disabled={update.isPending}>
        <Segmented
          label={t('ui.settings.title')}
          value={ui.density}
          options={(['off', 'normal', 'rich'] as const).map((value) => ({ value, label: t(`ui.settings.${value}`) }))}
          onChange={(density) => set({ density })}
        />
        <p className="text-xs leading-relaxed text-subtle">{t('ui.settings.hint')}</p>
        {(['dataAccess', 'inline', 'localModels'] as const).map((key) => (
          <label key={key} className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>{t(`ui.settings.${key}`)}</span>
            <Switch
              aria-label={t(`ui.settings.${key}`)}
              checked={key === 'localModels' ? ui.localModels === 'normal' : ui[key]}
              onCheckedChange={(checked) => set(key === 'localModels' ? { localModels: checked ? 'normal' : 'off' } : { [key]: checked })}
            />
          </label>
        ))}
      </fieldset>
    </section>
  )
}
