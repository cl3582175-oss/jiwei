import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, cn } from '@/lib/utils'
import { useSettings } from '@/lib/queries'
import type { ProviderInfo } from '@shared/types'
import type { AttachmentsController } from './useAttachments'
import { AttachmentBar, attachmentKind } from './AttachmentBar'

export function AttachmentDropZone({
  controller,
  children,
  className,
  style
}: {
  controller: AttachmentsController
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  const { t } = useTranslation(),
    [dragging, setDragging] = useState(false)
  return (
    <div
      style={style}
      className={cn('relative', className)}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.stopPropagation()
          setDragging(true)
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault()
          e.stopPropagation()
          setDragging(false)
          void controller.addFiles(Array.from(e.dataTransfer.files))
        }
      }}
    >
      {children}
      {dragging && (
        <div
          data-testid="attachment-drop-overlay"
          className="pointer-events-none absolute inset-1 z-50 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/90 p-4 text-center text-sm font-medium text-accent"
        >
          {t('attach.drop')}
        </div>
      )}
    </div>
  )
}
const starters = {
  document: ['summary', 'cornell', 'quiz', 'concepts'],
  code: ['summary', 'cornell', 'quiz', 'concepts'],
  table: ['patterns', 'chart', 'outliers'],
  slides: ['slides', 'script'],
  image: ['image', 'solve'],
  media: ['notes', 'timestamps']
}
export function AttachmentInput({
  controller,
  provider,
  text,
  newConversation = false,
  onSend,
  onMentionPicked
}: {
  controller: AttachmentsController
  provider?: ProviderInfo | null
  text: string
  newConversation?: boolean
  onSend?: (text: string) => void
  onMentionPicked?: () => void
}) {
  const { t } = useTranslation(),
    { data: settings } = useSettings()
  const kinds = new Set(controller.items.map(attachmentKind)),
    kind = kinds.size === 1 ? [...kinds][0] : 'document'
  const { data: matches = [] } = useQuery({
    queryKey: ['attachment-mention', controller.mentionQuery],
    enabled: controller.mention,
    queryFn: async () => {
      const [sources, notes] = await Promise.all([
        api.sources.list({ search: controller.mentionQuery || undefined }),
        api.notes.list({ search: controller.mentionQuery || undefined, limit: 40 })
      ])
      return [
        ...sources.map((a) => ({ id: a.id, title: a.title, excluded: a.aiExcluded })),
        ...notes.map((a) => ({ id: 'note:' + a.id, title: a.title, excluded: a.aiExcluded }))
      ].slice(0, 60)
    }
  })
  return (
    <div className="relative space-y-2 px-3 pt-2">
      {!!controller.items.length && provider && provider.kind !== 'ollama' && !settings?.attachments?.cloudNoticeSeen && (
        <div
          data-testid="attachment-cloud-notice"
          className="flex items-start gap-2 rounded-lg bg-accent-soft px-3 py-2 text-2xs text-muted"
        >
          <span className="flex-1">{t('attach.cloudNotice', { provider: provider.name })}</span>
          <button className="shrink-0 text-accent" onClick={() => void api.settings.set({ attachments: { cloudNoticeSeen: true } })}>
            {t('attach.gotIt')}
          </button>
        </div>
      )}
      <AttachmentBar items={controller.items} onRemove={controller.remove} />
      {newConversation && !text.trim() && controller.ids().length > 0 && onSend && (
        <div data-testid="attachment-starters" className="flex flex-wrap gap-1.5">
          {starters[kind].map((k) => (
            <button
              key={k}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted hover:text-accent"
              onClick={() => onSend(t('attach.starter.' + k))}
            >
              {t('attach.starter.' + k)}
            </button>
          ))}
        </div>
      )}
      {controller.mention && (
        <div
          role="dialog"
          aria-label={t('attach.mention')}
          className="absolute right-2 bottom-full left-2 z-50 max-h-64 overflow-auto rounded-xl border border-border bg-surface p-2 shadow-[var(--shadow-2)]"
        >
          <div className="flex items-center justify-between p-1 text-xs text-muted">
            <span>{t('attach.mention')}</span>
            <button onClick={controller.closeMention}>{t('attach.cancel')}</button>
          </div>
          {!matches.length && <p className="p-2 text-xs text-muted">{t('attach.mentionEmpty')}</p>}
          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-xs text-fg hover:bg-sunken"
              onClick={() =>
                void controller.reference(m.id).then(() => {
                  if (!m.excluded) onMentionPicked?.()
                })
              }
            >
              <span className="truncate">{m.title || t('common.untitled')}</span>
              {m.excluded && <span className="shrink-0 text-2xs text-muted">{t('attach.reason.aiExcluded')}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
