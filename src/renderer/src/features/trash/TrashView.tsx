import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Trash2, RotateCcw, NotebookText, Clock } from 'lucide-react'
import type { TrashItem } from '@shared/types'
import { useTrash, invalidate } from '@/lib/queries'
import { api, cn, formatRelative } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState, Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { FileStack } from 'lucide-react'

export function TrashView() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: items = [], isFetched } = useTrash()

  const refresh = (): void => invalidate(qc, 'trash', 'notes', 'sources')

  const restore = async (it: TrashItem): Promise<void> => {
    await api.trash.restore(it.type, it.id)
    refresh()
    toast.success(t('trash.restored'))
  }
  const purge = async (it: TrashItem): Promise<void> => {
    const ok = await confirm({
      title: t('trash.purgeTitle', { name: it.title || t('common.untitled') }),
      description: t('trash.purgeDesc'),
      confirmText: t('trash.purge'),
      danger: true
    })
    if (!ok) return
    await api.trash.purge(it.type, it.id)
    refresh()
  }
  const emptyAll = async (): Promise<void> => {
    const ok = await confirm({
      title: t('trash.emptyTitle'),
      description: t('trash.emptyDesc', { count: items.length }),
      confirmText: t('trash.purge'),
      danger: true
    })
    if (!ok) return
    await api.trash.empty()
    refresh()
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center justify-end border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[860px] px-10 pt-10 pb-16">
          <div className="flex items-end justify-between gap-6">
            <div>
              <h1 className="font-serif text-xl font-semibold tracking-wide text-fg">{t('trash.title')}</h1>
              <p className="mt-1.5 text-sm text-muted">{t('trash.desc')}</p>
            </div>
            {items.length > 0 && (
              <Button variant="outline" className="text-danger" onClick={() => void emptyAll()}>
                <Trash2 />
                {t('trash.emptyAll')}
              </Button>
            )}
          </div>

          {isFetched && items.length === 0 ? (
            <div className="h-[50vh]">
              <EmptyState icon={<Trash2 />} title={t('trash.empty')} />
            </div>
          ) : (
            <div className="mt-8 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-card">
              {items.map((it) => (
                <div key={`${it.type}:${it.id}`} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-surface-hover/60">
                  <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-muted [&_svg]:size-4">
                    {it.type === 'note' ? <NotebookText /> : <FileStack />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{it.title || t('common.untitled')}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-subtle">
                      <span>{t(`trash.${it.type}`)}</span>·<span>{formatRelative(it.deletedAt, i18n.language)}</span>·
                      <span className={cn('inline-flex items-center gap-1', it.daysLeft <= 3 && 'text-danger')}>
                        <Clock className="size-3" />
                        {it.daysLeft === 0 ? t('trash.today') : t('trash.daysLeft', { count: it.daysLeft })}
                      </span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => void restore(it)}>
                      <RotateCcw />
                      {t('common.restore')}
                    </Button>
                    <Tip label={t('trash.purge')} side="top">
                      <Button variant="ghost" size="icon-sm" className="hover:bg-danger-soft hover:text-danger" onClick={() => void purge(it)} aria-label={t('trash.purge')}>
                        <Trash2 />
                      </Button>
                    </Tip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
