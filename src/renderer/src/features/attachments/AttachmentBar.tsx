import { FileText, Sheet, Presentation, Image as ImageIcon, FileAudio, FileVideo, FileCode, X, Paperclip } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CODE_EXTS } from '@shared/attachments'
import type { Attachment } from '@shared/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useApp, openSourceAt } from '@/store/app'
import type { AttachmentsController } from './useAttachments'

export const formatAttachmentSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
export function attachmentKind(a: Attachment): 'document' | 'table' | 'slides' | 'image' | 'media' | 'code' {
  const ext = a.name.split('.').at(-1)?.toLowerCase() ?? ''
  if (['xlsx', 'csv'].includes(ext)) return 'table'
  if (ext === 'pptx') return 'slides'
  if (a.kind === 'image') return 'image'
  if (a.kind === 'audio' || a.kind === 'video') return 'media'
  if (CODE_EXTS.includes(ext)) return 'code'
  return 'document'
}
export function AttachmentIcon({ a }: { a: Attachment }) {
  const kind = attachmentKind(a),
    icons = {
      document: FileText,
      table: Sheet,
      slides: Presentation,
      image: ImageIcon,
      media: a.kind === 'video' ? FileVideo : FileAudio,
      code: FileCode
    },
    Icon = icons[kind]
  return a.thumbUrl && !a.deleted ? (
    <img src={a.thumbUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
  ) : (
    <Icon
      className="size-6 shrink-0"
      style={{ color: `var(--viz-${{ document: 1, table: 2, slides: 3, image: 4, media: 5, code: 6 }[kind]})` }}
    />
  )
}
export function openAttachment(a: Attachment): void {
  if (a.deleted) return
  if (a.sourceId.startsWith('note:')) useApp.getState().openNote(a.sourceId.slice(5))
  else openSourceAt(a.sourceId, new URLSearchParams(a.kind === 'audio' || a.kind === 'video' ? 't=0' : 'page=1'))
}
export function AttachmentBar({
  items,
  onRemove,
  small = false
}: {
  items: Attachment[]
  onRemove?: (id: string) => void
  small?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-2" aria-live="polite">
      {items.map((a) => (
        <div
          key={a.sourceId}
          data-testid="attachment-chip"
          data-status={a.status}
          className={cn(
            'relative flex w-[220px] max-w-full items-center gap-2 overflow-hidden rounded-lg border border-border bg-surface px-2.5 py-2',
            a.deleted && 'opacity-50'
          )}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            disabled={a.deleted || a.status === 'adding' || a.status === 'unsupported'}
            onClick={() => openAttachment(a)}
            aria-label={`${t('attach.preview')} ${a.name}`}
          >
            <AttachmentIcon a={a} />
            <span className="min-w-0">
              <span className={cn('block truncate text-xs font-medium text-fg', small && 'text-2xs')} title={a.name}>
                {a.name}
              </span>
              <span className="block truncate text-2xs text-muted" title={a.error ?? undefined}>
                {a.deleted
                  ? t('attach.deleted')
                  : `${formatAttachmentSize(a.size)} · ${t('attach.status.' + a.status, { p: Math.round((a.progress ?? 0) * 100), reason: a.error ?? '' })}`}
              </span>
              {a.space === 'library' && <span className="block text-right text-2xs text-muted">{t('attach.archived')}</span>}
            </span>
          </button>
          {onRemove && (
            <button
              type="button"
              className="self-start rounded text-muted hover:text-fg"
              aria-label={`${t('attach.remove')} ${a.name}`}
              onClick={() => onRemove(a.sourceId)}
            >
              <X className="size-3.5" />
            </button>
          )}
          {['adding', 'parsing', 'recognizing', 'transcribing'].includes(a.status) && (
            <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-sunken">
              <div className="h-full" style={{ background: 'var(--viz-1)', width: `${Math.max(5, (a.progress ?? 0) * 100)}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
export function AttachmentButton({ controller }: { controller: AttachmentsController }) {
  const { t } = useTranslation()
  return (
    <Button type="button" size="icon-sm" variant="ghost" onClick={() => void controller.pick()} aria-label={t('attach.add')}>
      <Paperclip className="size-4" />
    </Button>
  )
}
