import type { SafetyProgress as Progress } from '@shared/backup'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/utils'
import i18n from 'i18next'
import { useTranslation } from 'react-i18next'

export function safetyMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return message && !/^(?:Error:|ENOENT|EACCES|EPERM)|\n\s+at |ZodError/.test(message) ? message : i18n.t('safety.failed')
}
export function SafetyProgress({ value, cancel, pause = false }: { value: Progress; cancel: () => void; pause?: boolean }) {
  const { t } = useTranslation()
  if (value.state === 'idle') return null
  const running = value.state === 'running'
  return (
    <div className="space-y-2 rounded-xl border border-border bg-sunken p-4 text-[14px]" data-testid="safety-progress" role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={value.state === 'failed' ? 'text-danger' : 'text-fg'}>{value.message}</p>
        {running && (
          <Button variant="ghost" onClick={cancel}>
            {t(pause ? 'safety.pause' : 'safety.cancel')}
          </Button>
        )}
      </div>
      {running && (
        <>
          <div
            role="progressbar"
            aria-label={value.kind}
            aria-valuemin={0}
            aria-valuemax={value.total || 1}
            aria-valuenow={value.total ? value.processed : undefined}
            className="h-2 w-full overflow-hidden rounded-full bg-border"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{ width: value.total ? `${(100 * value.processed) / value.total}%` : '8%' }}
            />
          </div>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted">
            <span>
              {formatBytes(value.processed)} / {value.total ? formatBytes(value.total) : t('safety.counting')}
            </span>
            <span>
              {value.remainingSeconds === null
                ? t('safety.estimating')
                : value.remainingSeconds < 60
                  ? t('safety.remainingSeconds', { count: value.remainingSeconds })
                  : t('safety.remainingMinutes', { count: Math.ceil(value.remainingSeconds / 60) })}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
