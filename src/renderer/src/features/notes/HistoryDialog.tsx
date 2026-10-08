import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Dialog as D } from 'radix-ui'
import { generateHTML } from '@tiptap/core'
import { History, RotateCcw, X, Bookmark } from 'lucide-react'
import type { DocJSON } from '@shared/types'
import { api, cn, formatDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { previewExtensions } from './editor/preview'

/** 版本历史：左侧时间线，右侧只读预览，可恢复到任意版本 */
export function HistoryDialog({
  noteId,
  open,
  onOpenChange,
  onRestore
}: {
  noteId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  onRestore: (doc: DocJSON) => void
}) {
  const { t, i18n } = useTranslation()
  const { data: list = [] } = useQuery({ queryKey: ['revisions', noteId], queryFn: () => api.revisions.list(noteId), enabled: open })
  const [selected, setSelected] = useState<string | null>(null)
  const current = selected ?? list[0]?.id ?? null
  const { data: rev } = useQuery({
    queryKey: ['revision', current],
    queryFn: () => api.revisions.get(current!),
    enabled: open && !!current
  })

  const extensions = useMemo(() => previewExtensions({ summary: t('notes.summary'), cueHint: '', bodyHint: '', summaryHint: '' }), [t])
  const html = useMemo(() => {
    if (!rev) return ''
    try {
      return generateHTML(rev.doc, extensions)
    } catch {
      return ''
    }
  }, [rev, extensions])

  const restore = async (): Promise<void> => {
    if (!rev) return
    const ok = await confirm({
      title: t('history.restoreTitle'),
      description: t('history.restoreDesc', { time: formatDateTime(rev.createdAt, i18n.language) }),
      confirmText: t('history.restore')
    })
    if (!ok) return
    await api.revisions.create(noteId, 'restore')
    onRestore(rev.doc)
    onOpenChange(false)
  }

  return (
    <D.Root open={open} onOpenChange={(o) => (onOpenChange(o), o || setSelected(null))}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 flex h-[min(86vh,680px)] w-[min(94vw,1100px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-float outline-none data-[state=open]:animate-[dialog-in_220ms_cubic-bezier(0.2,0.9,0.3,1)]">
          <D.Description className="sr-only">{t('history.title')}</D.Description>
          <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-sunken">
            <D.Title className="flex items-center gap-2 px-5 pt-5 pb-4 font-serif text-md font-semibold text-fg">
              <History className="size-4 text-accent" />
              {t('history.title')}
            </D.Title>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              {list.length === 0 && <p className="px-3 py-6 text-xs leading-relaxed text-subtle">{t('history.empty')}</p>}
              {list.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  className={cn(
                    'mb-0.5 w-full rounded-lg px-3 py-2.5 text-left transition-colors',
                    r.id === current ? 'bg-surface shadow-card' : 'hover:bg-surface-hover'
                  )}
                >
                  <div className="flex items-center gap-1.5 text-sm text-fg">
                    {r.reason !== 'auto' && <Bookmark className="size-3 fill-accent text-accent" />}
                    {formatDateTime(r.createdAt, i18n.language)}
                  </div>
                  <div className="mt-0.5 text-2xs text-subtle">
                    {t(`history.reason.${r.reason}`)} · {t('common.words', { count: r.wordCount })}
                  </div>
                </button>
              ))}
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border pr-14 pl-8">
              <span className="truncate font-serif text-md font-semibold text-fg">{rev?.title || t('common.untitled')}</span>
              <Button variant="primary" size="sm" disabled={!rev} onClick={() => void restore()}>
                <RotateCcw />
                {t('history.restore')}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-bg px-10 py-8">
              <div className="cornell-card pointer-events-none select-text">
                <div className="prose-jiwei cornell-doc" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            </div>
          </div>
          <D.Close className="absolute top-4 right-4 rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-fg">
            <X className="size-4" />
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
