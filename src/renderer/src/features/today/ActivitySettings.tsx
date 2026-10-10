import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { api } from '@/lib/utils'

/** 设置 → 数据：学习活动记录（v0.6.7）的说明与清除 */
export function ActivitySettings() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const clear = async (): Promise<void> => {
    if (!(await confirm({ title: t('today.activity.clearTitle'), description: t('today.activity.clearDesc'), danger: true, confirmText: t('today.activity.clear') })))
      return
    setBusy(true)
    try {
      await api.activity.clear()
      void qc.invalidateQueries({ queryKey: ['today'] })
      void qc.invalidateQueries({ queryKey: ['heatmap'] })
      toast.success(t('today.activity.cleared'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-2 py-4" data-testid="activity-settings">
      <h3 className="text-sm font-medium text-fg">{t('today.activity.title')}</h3>
      <p className="text-xs leading-relaxed text-muted">{t('today.activity.desc')}</p>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void clear()}>
        {t('today.activity.clear')}
      </Button>
    </section>
  )
}
