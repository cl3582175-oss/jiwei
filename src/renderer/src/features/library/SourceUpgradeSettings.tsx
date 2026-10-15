import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/utils'
import { keys, useSettings } from '@/lib/queries'
import { Switch } from '@/components/ui/switch'
import { errText } from '../chat/useChat'

export function SourceUpgradeSettings() {
  const { t } = useTranslation(),
    qc = useQueryClient(),
    { data: settings } = useSettings()
  const { data: progress } = useQuery({ queryKey: ['source-upgrade'], queryFn: () => api.retrieval.upgradeStatus() })
  const update = useMutation({
    mutationFn: (autoUpgrade: boolean) => api.settings.set({ retrieval: { autoUpgrade } }),
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s)
      void qc.invalidateQueries({ queryKey: ['source-upgrade'] })
    },
    onError: (e) => toast.error(errText(e))
  })
  if (!settings || !progress) return null
  if (progress.done === progress.total)
    return (
      <p className="border-t border-border pt-3 text-xs text-subtle" data-testid="source-upgrade">
        {t('readyUpgradeDone')}
      </p>
    )
  return (
    <section className="space-y-2 border-t border-border pt-4" data-testid="source-upgrade">
      <h4 className="text-sm font-medium text-fg">{t('readyUpgradeTitle')}</h4>
      <p className="text-xs leading-relaxed text-muted">{t('readyUpgradeDesc')}</p>
      <p className="text-2xs tabular-nums text-subtle">{t('readyUpgradeProgress', progress)}</p>
      <label className="flex items-center justify-between gap-3 text-xs text-fg">
        {t('readyUpgradeToggle')}
        <Switch
          aria-label={t('readyUpgradeToggle')}
          checked={settings.retrieval.autoUpgrade}
          disabled={update.isPending}
          onCheckedChange={(value) => update.mutate(value)}
        />
      </label>
    </section>
  )
}
