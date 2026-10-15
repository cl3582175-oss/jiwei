import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatMessage } from '@shared/types'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ReadinessAction, readinessText } from '../library/ReadinessNotice'
import { useReadinessMany } from '../library/useReadiness'
import { errText } from './useChat'

export function MessageReadiness({ message }: { message: ChatMessage }) {
  const { t } = useTranslation(),
    qc = useQueryClient(),
    [asked, setAsked] = useState(false),
    [busy, setBusy] = useState(false)
  const snapshots = message.readiness ?? []
  const live = useReadinessMany(
    snapshots.map((item) => item.sourceId),
    message.conversationId
  )
  const entries = snapshots.flatMap((item) => {
    const current = live.data?.[item.sourceId]
    if (live.isFetched && !current) return []
    const r = current ?? item.readiness
    const wasScan =
      (item.readiness.state === 'partial' || item.readiness.state === 'unreadable') && item.readiness.reason === 'scan-pending'
    const recognized = wasScan && (r.state === 'ready' || (r.state === 'preparing' && r.reason === 'indexing'))
    return r.state === 'ready' && !recognized ? [] : [{ ...item, readiness: r, recognized }]
  })
  if (!entries.length) return null
  const askAgain = async () => {
    setBusy(true)
    try {
      const [messages, conversation] = await Promise.all([api.chat.messages(message.conversationId), api.chat.get(message.conversationId)])
      const index = messages.findIndex((m) => m.id === message.id)
      const previous = messages
        .slice(0, index)
        .reverse()
        .find((m) => m.role === 'user')
      if (!previous || !conversation || !message.providerId || !message.model) throw new Error(t('readyChatAskAgain'))
      await api.chat.send({
        conversationId: conversation.id,
        text: previous.content,
        scope: conversation.scope,
        providerId: message.providerId,
        model: message.model,
        effort: message.effort ?? 'off'
      })
      setAsked(true)
      void qc.invalidateQueries({ queryKey: ['messages', conversation.id] })
      void qc.invalidateQueries({ queryKey: ['conversations'] })
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-testid="chat-readiness" role="status" className="mt-2 flex items-start gap-2 text-2xs leading-relaxed text-muted">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
      <div className="min-w-0 flex-1">
        {entries.slice(0, 2).map((item) => (
          <span key={item.sourceId} className="inline">
            <span>
              {item.recognized ? t('readyChatDone') : t('readyChatNote', { title: item.title, status: readinessText(item.readiness, t) })}
            </span>
            {!item.recognized && (
              <ReadinessAction sourceId={item.sourceId} readiness={item.readiness} conversationId={message.conversationId} />
            )}{' '}
          </span>
        ))}
        {entries.length > 2 && <span>{t('readyChatMore', { n: entries.length - 2 })}</span>}
        {entries.some((item) => item.recognized) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-1.5 py-0.5 text-2xs text-accent"
            disabled={busy || asked}
            onClick={() => void askAgain()}
          >
            {t('readyChatAskAgain')}
          </Button>
        )}
      </div>
    </div>
  )
}
