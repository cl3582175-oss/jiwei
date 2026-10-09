import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Popover } from 'radix-ui'
import { Loader2, CircleAlert, RotateCw, X, Check } from 'lucide-react'
import { api, cn } from '@/lib/utils'
import { Tip } from './ui/primitives'

/** 后台任务指示器：有任务运行或失败时出现在导航栏 */
export function JobsIndicator() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs.list() })
  useEffect(() => window.jiweiEvents.on('jobs:changed', () => void qc.invalidateQueries({ queryKey: ['jobs'] })), [qc])

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  const failed = jobs.filter((j) => j.status === 'failed')
  const canceledRecognition = jobs.filter((j) => j.status === 'canceled' && j.kind === 'inbox.recognize')
  if (active.length === 0 && failed.length === 0 && canceledRecognition.length === 0) return null
  const recent = jobs.filter((j) => j.status !== 'canceled' || j.kind === 'inbox.recognize').slice(0, 12)

  return (
    <Popover.Root>
      <Tip
        label={
          active.length
            ? t('jobs.running', { count: active.length })
            : failed.length
              ? t('jobs.failed', { count: failed.length })
              : t('inbox.recognition.canceled')
        }
      >
        <Popover.Trigger asChild>
          <button
            className={cn(
              'no-drag grid size-10 place-items-center rounded-[10px] transition-colors hover:bg-surface-hover',
              failed.length && !active.length ? 'text-danger' : 'text-accent'
            )}
            aria-label={t('jobs.title')}
          >
            {active.length ? (
              <Loader2 className="size-[18px] animate-spin" />
            ) : failed.length ? (
              <CircleAlert className="size-[18px]" />
            ) : (
              <RotateCw className="size-[18px]" />
            )}
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="end"
          sideOffset={10}
          className="z-50 w-80 rounded-xl border border-border bg-surface p-2 shadow-float data-[state=open]:animate-[pop-in_140ms_ease-out]"
        >
          <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted">{t('jobs.title')}</p>
          {recent.map((j) => (
            <div key={j.id} className="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm">
              <span className="shrink-0 [&_svg]:size-4">
                {j.status === 'running' || j.status === 'queued' ? (
                  <Loader2 className="animate-spin text-accent" />
                ) : j.status === 'failed' ? (
                  <CircleAlert className="text-danger" />
                ) : j.status === 'canceled' ? (
                  <X className="text-subtle" />
                ) : (
                  <Check className="text-subtle" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-fg">{t(j.title, { defaultValue: j.title })}</p>
                {j.status === 'canceled' && j.kind === 'inbox.recognize' && (
                  <p className="text-2xs text-subtle">{t('inbox.recognition.canceled')}</p>
                )}
                {j.status === 'running' && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                  </div>
                )}
                {j.status === 'failed' && j.error && (
                  <p className="truncate text-2xs text-danger" title={j.error}>
                    {j.error}
                  </p>
                )}
              </div>
              {(j.status === 'failed' || (j.status === 'canceled' && j.kind === 'inbox.recognize')) && (
                <button
                  onClick={() => void api.jobs.retry(j.id)}
                  className="rounded p-1 text-subtle hover:text-fg"
                  aria-label={t('jobs.retry')}
                >
                  <RotateCw className="size-3.5" />
                </button>
              )}
              {(j.status === 'queued' || j.status === 'running') && (
                <button
                  onClick={() => void api.jobs.cancel(j.id)}
                  className="rounded p-1 text-subtle hover:text-fg"
                  aria-label={t('common.cancel')}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
