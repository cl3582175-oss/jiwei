import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/utils'

/**
 * AI 记住新内容时提示：普通内容“记住了 … · 撤销”；敏感内容先问“要记住吗？”。
 * 同时刷新记忆列表。
 */
export function useMemoryToasts(): void {
  const { t } = useTranslation()
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('memory:changed', ({ added }) => {
        void qc.invalidateQueries({ queryKey: ['memories'] })
        if (!added) return
        if (added.status === 'pending') {
          toast(t('memory.askTitle'), {
            description: added.content,
            duration: 20_000,
            action: { label: t('memory.confirm'), onClick: () => void api.memory.confirm(added.id) },
            cancel: { label: t('memory.dismiss'), onClick: () => void api.memory.remove(added.id) }
          })
        } else {
          toast(t('memory.rememberedTitle'), {
            description: added.content,
            duration: 8000,
            action: { label: t('memory.undo'), onClick: () => void api.memory.remove(added.id) }
          })
        }
      }),
    [qc, t]
  )
}
