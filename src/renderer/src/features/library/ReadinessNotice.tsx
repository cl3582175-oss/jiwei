import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, LoaderCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import { readinessMessage, type Readiness } from '@shared/readiness'
import { api, cn } from '@/lib/utils'
import { Tip } from '@/components/ui/primitives'
import { Button } from '@/components/ui/button'
import { errText } from '../chat/useChat'

export function ReadinessAction({
  sourceId,
  readiness,
  conversationId = null
}: {
  sourceId: string
  readiness: Readiness
  conversationId?: string | null
}) {
  const { t } = useTranslation(),
    [busy, setBusy] = useState(false)
  const action = 'action' in readiness ? readiness.action : null
  const retry = readiness.state === 'unreadable' && readiness.reason === 'failed'
  if (!action && !retry) return null
  const key = retry
    ? 'readyActRetry'
    : action === 'recognize'
      ? 'readyActRecognize'
      : action === 'install-recognizer'
        ? 'readyActInstall'
        : 'readyActTranscribe'
  const run = async () => {
    setBusy(true)
    try {
      if (retry) await api.sources.retry(sourceId, conversationId)
      else if (action === 'recognize') await api.recognition.start(sourceId)
      else if (action === 'install-recognizer') await api.recognition.install()
      else if (action === 'transcribe') await api.asr.transcribe(sourceId)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-auto shrink-0 px-1.5 py-0.5 text-2xs text-accent"
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation()
        void run()
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {busy && <LoaderCircle className="size-3 animate-spin" />}
      {t(key)}
    </Button>
  )
}
export function readinessText(readiness: Readiness, t: (key: string, values?: Record<string, string | number>) => string): string {
  const message = readinessMessage(readiness)
  return message ? t(message.key, message.values) : ''
}
export function ReadinessLabel({
  sourceId,
  readiness,
  conversationId = null
}: {
  sourceId: string
  readiness?: Readiness
  conversationId?: string | null
}) {
  const { t } = useTranslation()
  if (!readiness || readiness.state === 'ready') return null
  const text = readinessText(readiness, t),
    detail = text + ('note' in readiness && readiness.note ? '\n' + readiness.note : '')
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1" data-testid="readiness-label">
      <Tip label={detail}>
        <span
          className={cn(
            'truncate rounded-md bg-sunken px-1.5 py-0.5 text-2xs',
            readiness.state === 'preparing' ? 'text-muted' : readiness.state === 'partial' ? 'text-[var(--warning)]' : 'text-danger'
          )}
        >
          {text}
        </span>
      </Tip>
      <ReadinessAction sourceId={sourceId} readiness={readiness} conversationId={conversationId} />
    </div>
  )
}
const dismissed = new Set<string>()
export function ReadinessBanner({
  sourceId,
  readiness,
  conversationId = null
}: {
  sourceId: string
  readiness?: Readiness
  conversationId?: string | null
}) {
  const { t } = useTranslation(),
    [closed, setClosed] = useState(() => dismissed.has(sourceId))
  if (closed || !readiness || readiness.state === 'ready') return null
  return (
    <div
      role="status"
      data-testid="source-readiness"
      className="flex shrink-0 items-start gap-2 border-b border-border bg-surface/80 px-4 py-2 text-xs text-muted"
    >
      <CircleAlert
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          readiness.state === 'unreadable' ? 'text-danger' : readiness.state === 'partial' ? 'text-[var(--warning)]' : 'text-subtle'
        )}
      />
      <span className="min-w-0 flex-1">
        {readinessText(readiness, t)}
        {'note' in readiness && readiness.note && <span className="block text-2xs text-subtle">{readiness.note}</span>}
      </span>
      <ReadinessAction sourceId={sourceId} readiness={readiness} conversationId={conversationId} />
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t('common.close')}
        onClick={() => {
          dismissed.add(sourceId)
          setClosed(true)
        }}
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}
