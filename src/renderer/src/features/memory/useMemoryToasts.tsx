import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'

/**
 * AI 记住新内容时提示：普通内容“记住了 … · 撤销”；敏感内容先问“要记住吗？”。
 * 对话后的自动整理合并成一条提示（查看 / 撤销）。同时刷新记忆、学习情况。
 */
export function useMemoryToasts(): void {
  const { t } = useTranslation()
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('memory:changed', ({ added, learned }) => {
        void qc.invalidateQueries({ queryKey: ['memories'] })
        void qc.invalidateQueries({ queryKey: ['concepts'] })
        if (learned?.length) {
          toast(t('memory.learnedTitle', { count: learned.length }), {
            description: learned
              .slice(0, 3)
              .map((m) => `· ${m.content}`)
              .join('\n'),
            duration: 10_000,
            action: { label: t('memory.view'), onClick: () => useApp.getState().openSettings('me') },
            // 撤销：新记住的删除；被改写的恢复原来的内容
            cancel: {
              label: t('memory.undo'),
              onClick: () =>
                void Promise.all(
                  learned.map((m) =>
                    m.evidence?.previous
                      ? api.memory.save({ id: m.id, kind: m.kind, content: m.evidence.previous })
                      : api.memory.remove(m.id)
                  )
                )
            }
          })
          return
        }
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
