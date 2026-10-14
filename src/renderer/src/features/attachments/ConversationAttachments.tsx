import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/utils'
import { useCategories } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import type { Attachment } from '@shared/types'
import { AttachmentBar } from './AttachmentBar'
import { errText } from '../chat/useChat'

export function useAttachmentEvents(): void {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('attachments:changed', () => {
        for (const key of ['conversation-attachments', 'attachment-message', 'attachment-space', 'attachment-count'])
          void qc.invalidateQueries({ queryKey: [key] })
      }),
    [qc]
  )
}
export function ArchiveAttachmentsDialog({
  ids,
  onClose,
  onArchived
}: {
  ids: string[]
  onClose: () => void
  onArchived?: (categoryId: string | null) => void
}) {
  const { t } = useTranslation(),
    { data: categories = [] } = useCategories('source'),
    [category, setCategory] = useState(''),
    [busy, setBusy] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent title={t('attach.archive')} className="max-w-sm">
        <select
          aria-label={t('attach.archiveTo')}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm text-fg"
        >
          <option value="">{t('attach.uncategorized')}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            {t('attach.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void api.attachments
                .archive(ids, category || null)
                .then(() => {
                  toast.success(t('attach.space.archivedToast', { n: ids.length }))
                  onArchived?.(category || null)
                  onClose()
                })
                .catch((e) => toast.error(errText(e)))
                .finally(() => setBusy(false))
            }}
          >
            {t('attach.archive')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
export async function deleteAttachmentRows(ids: string[]): Promise<void> {
  if (
    await confirm({
      title: (await import('i18next')).default.t('attach.delete'),
      description: (await import('i18next')).default.t('attach.deleteConfirm'),
      danger: true
    })
  )
    await api.attachments.delete(ids)
}
export function ConversationAttachments({ conversationId, incognito = false }: { conversationId: string | null; incognito?: boolean }) {
  const { t } = useTranslation(),
    [open, setOpen] = useState(false),
    [archive, setArchive] = useState<string[]>([])
  useAttachmentEvents()
  const { data: items = [] } = useQuery({
    queryKey: ['conversation-attachments', conversationId],
    queryFn: () => api.attachments.ofConversation(conversationId!),
    enabled: !!conversationId
  })
  if (!conversationId || !items.length) return null
  return (
    <>
      <Button size="sm" variant="ghost" className="no-drag" onClick={() => setOpen(true)}>
        {t('attach.inConversation', { n: items.length })}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={t('attach.inConversation', { n: items.length })} className="max-w-lg">
          <div data-testid="conversation-attachments" className="max-h-[60vh] space-y-3 overflow-auto">
            {items.map((a) => (
              <div key={a.sourceId} className="flex flex-wrap items-center gap-2">
                <AttachmentBar items={[a]} small />
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void api.attachments.removeFromConversation(conversationId, a.sourceId).catch((e) => toast.error(errText(e)))
                    }
                  >
                    {t('attach.removeFromConversation')}
                  </Button>
                  {!a.sourceId.startsWith('note:') && (
                    <>
                      {!incognito && a.space === 'attachment' && !a.deleted && (
                        <Button size="sm" variant="ghost" onClick={() => setArchive([a.sourceId])}>
                          {t('attach.archive')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={a.deleted}
                        onClick={() => void deleteAttachmentRows([a.sourceId]).catch((e) => toast.error(errText(e)))}
                      >
                        {t('attach.delete')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      {!!archive.length && <ArchiveAttachmentsDialog ids={archive} onClose={() => setArchive([])} />}
    </>
  )
}
export function MessageAttachments({ items }: { items: Attachment[] }) {
  useAttachmentEvents()
  const { data: rows } = useQuery({
    queryKey: ['attachment-message', items.map((a) => a.sourceId)],
    queryFn: () => api.attachments.status(items.map((a) => a.sourceId)),
    refetchInterval: (q) => (q.state.data?.some((a) => ['parsing', 'recognizing', 'transcribing'].includes(a.status)) ? 1000 : false)
  })
  return (
    <div data-testid="message-attachments" className="mt-2">
      <AttachmentBar
        small
        items={rows ? items.map((a) => rows.find((r) => r.sourceId === a.sourceId) ?? { ...a, deleted: true }) : items}
      />
    </div>
  )
}
