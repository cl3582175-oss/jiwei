import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { ReplyQuote, useReplyQuote } from '../assist/ReplyQuote'
import { quotedMessage } from '../assist/replySelection'
import { useAssist } from '../assist/store'
import { AttachmentInput } from '../attachments/AttachmentInput'
import { AttachmentButton } from '../attachments/AttachmentBar'
import type { AttachmentsController } from '../attachments/useAttachments'

export function Composer({
  busy,
  onSend,
  onStop,
  placeholder,
  prefill,
  attachments,
  provider,
  newConversation,
  conversationId,
  attachmentButton,
  disabled = false
}: {
  busy: boolean
  onSend: (text: string) => void | boolean | Promise<void | boolean>
  onStop: () => void
  placeholder?: string
  /** 预填的文字（角色起步卡）：只填入输入框，由用户检查后发送 */
  prefill?: string
  attachments?: AttachmentsController
  provider?: import('@shared/types').ProviderInfo | null
  newConversation?: boolean
  conversationId?: string | null
  attachmentButton?: ReactNode
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const quote = useReplyQuote(conversationId)
  useEffect(() => {
    if (quote) ref.current?.focus()
  }, [quote])
  const ref = useRef<HTMLTextAreaElement>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => ref.current?.focus(), [])
  const resize = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }
  useEffect(() => {
    if (!prefill) return
    setText(prefill)
    requestAnimationFrame(() => {
      resize()
      ref.current?.setSelectionRange(prefill.length, prefill.length)
    })
  }, [prefill])
  const submit = async (value = text): Promise<void> => {
    if ((!value.trim() && !attachments?.ids().length) || busy || disabled || sending || attachments?.adding) return
    setSending(true)
    try {
      if ((await onSend(quotedMessage(value.trim(), quote))) !== false) {
        if (conversationId) useAssist.getState().setReplyQuote(conversationId, null)
        setText((current) => (current === text ? '' : current))
        requestAnimationFrame(resize)
      }
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="relative">
      <ReplyQuote conversationId={conversationId} />
      {attachments && (
        <AttachmentInput
          controller={attachments}
          provider={provider}
          text={text}
          newConversation={newConversation}
          onSend={(q) => void submit(q)}
          onMentionPicked={() => setText(text.replace(/@[^\s@]*$/, ''))}
        />
      )}
      <textarea
        ref={ref}
        rows={1}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          attachments?.textChanged(e.target.value)
          resize()
        }}
        onPaste={attachments?.paste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={placeholder ?? t('chat.placeholder')}
        aria-label={placeholder ?? t('chat.placeholder')}
        className="block max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm leading-relaxed text-fg outline-none placeholder:text-subtle"
      />
      {attachments && <div className="px-2 pb-2">{attachmentButton ?? <AttachmentButton controller={attachments} />}</div>}
      <div className="absolute right-2.5 bottom-2.5">
        {busy ? (
          <Tip label={t('chat.stop')} side="top">
            <Button size="icon-sm" variant="secondary" className="rounded-full" onClick={onStop} aria-label={t('chat.stop')}>
              <Square className="size-3 fill-current" />
            </Button>
          </Tip>
        ) : (
          <Tip label={t('chat.sendHint')} side="top">
            <Button
              size="icon-sm"
              variant="primary"
              className="rounded-full"
              disabled={disabled || (!text.trim() && !attachments?.ids().length) || sending || attachments?.adding}
              onClick={() => void submit()}
              aria-label={t('chat.send')}
            >
              <ArrowUp />
            </Button>
          </Tip>
        )}
      </div>
    </div>
  )
}
