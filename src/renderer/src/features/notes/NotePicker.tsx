import { useState } from 'react'
import { Command } from 'cmdk'
import { Dialog as D } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { NotebookText, Search } from 'lucide-react'
import { useNotes } from '@/lib/queries'
import { formatDate } from '@/lib/utils'

/** 选择一篇笔记（如“被哪篇笔记取代”） */
export function NotePicker({
  open,
  onOpenChange,
  title,
  excludeId,
  onPick
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  excludeId?: string
  onPick: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [q, setQ] = useState('')
  const { data: notes = [] } = useNotes({ search: q, sort: 'edited', limit: 50 })
  return (
    <D.Root open={open} onOpenChange={(o) => (onOpenChange(o), o || setQ(''))}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]" />
        <D.Content className="fixed top-[19%] left-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-float outline-none data-[state=open]:animate-[pop-in_160ms_ease-out]">
          <D.Title className="px-5 pt-4 text-sm font-medium text-fg">{title}</D.Title>
          <D.Description className="sr-only">{title}</D.Description>
          <Command shouldFilter={false} loop>
            <div className="mt-2 flex items-center gap-3 border-b border-border px-5">
              <Search className="size-4 text-subtle" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder={t('notes.searchPlaceholder')}
                className="h-11 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
              />
            </div>
            <Command.List className="max-h-[360px] overflow-y-auto p-2">
              <Command.Empty className="py-8 text-center text-sm text-subtle">{t('palette.empty')}</Command.Empty>
              {notes
                .filter((n) => n.id !== excludeId)
                .map((n) => (
                  <Command.Item
                    key={n.id}
                    value={n.id}
                    onSelect={() => {
                      onPick(n.id)
                      onOpenChange(false)
                    }}
                    className="flex h-10 cursor-default items-center gap-3 rounded-lg px-3 text-sm text-fg data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent"
                  >
                    <NotebookText className="size-4 shrink-0 text-subtle" />
                    <span className="truncate">{n.title || t('common.untitled')}</span>
                    <span className="ml-auto shrink-0 text-xs text-subtle">{formatDate(n.learnedAt, i18n.language)}</span>
                  </Command.Item>
                ))}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
