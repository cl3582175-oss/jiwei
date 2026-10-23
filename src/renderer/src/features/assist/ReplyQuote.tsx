import { X, Quote } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAssist } from './store'
import { Context } from '@/components/ai-elements/context'
export function useReplyQuote(id?: string | null): string | null {
  return useAssist((s) => (id ? (s.replyQuotes[id] ?? null) : null))
}
export function ReplyQuote({ conversationId }: { conversationId?: string | null }) {
  const { t } = useTranslation()
  const text = useReplyQuote(conversationId)
  if (!text || !conversationId) return null
  return (
    <Context
      data-testid="reply-quote"
      className="mx-3 mt-2 flex items-start gap-2 rounded-lg border-l-2 border-accent bg-accent-soft px-3 py-2 text-xs text-muted"
    >
      <Quote className="size-3.5 shrink-0" />
      <span className="line-clamp-3 flex-1 whitespace-pre-wrap">{text}</span>
      <button aria-label={t('assist.removeQuote')} onClick={() => useAssist.getState().setReplyQuote(conversationId, null)}>
        <X className="size-3.5" />
      </button>
    </Context>
  )
}
