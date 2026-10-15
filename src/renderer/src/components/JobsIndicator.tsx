import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Popover } from 'radix-ui'
import { Loader2, CircleAlert, RotateCw, X, Check, Clock } from 'lucide-react'
import { api, cn } from '@/lib/utils'
import { Tip } from './ui/primitives'

/** 后台任务指示器：有任务运行或失败时出现在导航栏 */
export function JobsIndicator() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs.list() })
  const [now, setNow] = useState(Date.now)
  useEffect(() => window.jiweiEvents.on('jobs:changed', () => void qc.invalidateQueries({ queryKey: ['jobs'] })), [qc])
  useEffect(() => {
    setNow(Date.now())
    if (!jobs.some((job) => job.status === 'queued')) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [jobs])

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  const failed = jobs.filter((j) => j.status === 'failed')
  const canceledRecognition = jobs.filter((j) => j.status === 'canceled' && j.kind === 'inbox.recognize')
  if (active.length === 0 && failed.length === 0 && canceledRecognition.length === 0) return null
  const recent = jobs.filter((j) => j.status !== 'canceled' || j.kind === 'inbox.recognize')
  const groups = (['user', 'background'] as const)
    .map((lane) => ({ lane, entries: recent.filter((job) => job.lane === lane).slice(0, 12) }))
    .filter((group) => group.entries.length)
  const runningUsers = active.filter((job) => job.lane === 'user' && job.status === 'running').length
  const queuedUsers = active
    .filter((job) => job.lane === 'user' && job.status === 'queued' && !job.waiting && job.runAfter <= now)
    .sort((a, b) => a.runAfter - b.runAfter || a.createdAt - b.createdAt || a.id.localeCompare(b.id))

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
          className="z-50 max-h-[80vh] w-80 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-float data-[state=open]:animate-[pop-in_140ms_ease-out]"
        >
          <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted">{t('jobs.title')}</p>
          {groups.map(({ lane, entries }) => (
            <section key={lane} data-testid={`jobs-lane-${lane}`} aria-label={t(`jobs.${lane}`)}>
              <h3 className="px-2 pt-2 pb-1 text-2xs font-medium text-muted">{t(`jobs.${lane}`)}</h3>
              {entries.map((j) => (
                <div key={j.id} data-testid={`job-${j.id}`} className="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm">
                  <span className="shrink-0 [&_svg]:size-4">
                    {j.status === 'queued' && (j.waiting || j.yielded || j.runAfter > now + 60_000) ? (
                      <Clock className="text-subtle" />
                    ) : j.status === 'running' || j.status === 'queued' ? (
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
                    {j.status === 'queued' && j.waiting && (
                      <p className="text-2xs text-subtle">
                        {j.waiting.reason === 'parsing' ? t('jobs.waitingParsing') : t('jobs.waitingRecognition', j.waiting)}
                        {j.waiting.reason === 'recognition' && (
                          <button onClick={() => void api.jobs.digestNow(j.id)} className="ml-2 text-accent hover:underline">
                            {t('jobs.digestNow')}
                          </button>
                        )}
                      </p>
                    )}
                    {j.status === 'queued' && j.yielded && !j.waiting && <p className="text-2xs text-subtle">{t('jobs.yielded')}</p>}
                    {j.status === 'queued' && !j.waiting && !j.yielded && j.lane === 'user' && j.runAfter <= now && (
                      <p className="text-2xs text-subtle">
                        {t('jobs.ahead', {
                          count:
                            runningUsers +
                            Math.max(
                              0,
                              queuedUsers.findIndex((job) => job.id === j.id)
                            )
                        })}
                      </p>
                    )}
                    {j.status === 'queued' && !j.waiting && !j.yielded && j.runAfter > now + 60_000 && (
                      <p className="text-2xs text-subtle" data-testid="job-offpeak">
                        {t('spend.jobs.offPeak', {
                          time: new Date(j.runAfter).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                        })}
                        <button onClick={() => void api.jobs.runNow(j.id)} className="ml-2 text-accent hover:underline">
                          {t('spend.jobs.runNow')}
                        </button>
                      </p>
                    )}
                    {j.status === 'canceled' && j.kind === 'inbox.recognize' && (
                      <p className="text-2xs text-subtle">{t('inbox.recognition.canceled')}</p>
                    )}
                    {(j.status === 'running' || j.yielded) && (
                      <div
                        role="progressbar"
                        aria-label={j.title}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(j.progress * 100)}
                        className="mt-1 h-1 overflow-hidden rounded-full bg-sunken"
                      >
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
            </section>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
