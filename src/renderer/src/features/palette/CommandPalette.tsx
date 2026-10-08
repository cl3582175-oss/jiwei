import { useState } from 'react'
import { Command } from 'cmdk'
import { Dialog as D } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { NotebookText, PenLine, Library, Settings, Trash2, Search, Home } from 'lucide-react'
import { useApp } from '@/store/app'
import { useNotes } from '@/lib/queries'
import { useCreateNote } from '@/lib/shortcuts'
import { modKey } from '@/lib/utils'
import { Kbd } from '@/components/ui/primitives'

const itemCls =
  'flex h-10 cursor-default items-center gap-3 rounded-lg px-3 text-sm text-fg data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-subtle data-[selected=true]:[&_svg]:text-accent'

export function CommandPalette() {
  const { t } = useTranslation()
  const { paletteOpen, setPaletteOpen, openNote, setView, setSettingsOpen } = useApp()
  const [q, setQ] = useState('')
  const { data: notes = [] } = useNotes({ search: q, sort: 'updated' })
  const createNote = useCreateNote()

  const run = (fn: () => void) => () => {
    setPaletteOpen(false)
    setQ('')
    fn()
  }

  return (
    <D.Root open={paletteOpen} onOpenChange={(o) => (setPaletteOpen(o), o || setQ(''))}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_140ms_ease-out]" />
        <D.Content className="fixed top-[19%] left-1/2 z-50 w-[min(92vw,620px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-float outline-none data-[state=open]:animate-[pop-in_160ms_ease-out]">
          <D.Title className="sr-only">{t('nav.search')}</D.Title>
          <D.Description className="sr-only">{t('palette.placeholder')}</D.Description>
          {/* 笔记检索由数据库完成，关闭 cmdk 自带过滤 */}
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search className="size-[18px] text-subtle" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder={t('palette.placeholder')}
                className="h-14 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-subtle"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[min(420px,50vh)] overflow-y-auto p-2">
              <Command.Empty className="py-10 text-center text-sm text-subtle">{t('palette.empty')}</Command.Empty>
              {!q && (
                <Command.Group heading={t('palette.actions')} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:text-subtle">
                  <Command.Item className={itemCls} onSelect={run(() => void createNote())}>
                    <PenLine />
                    <span className="flex-1">{t('notes.new')}</span>
                    <Kbd>{modKey}N</Kbd>
                  </Command.Item>
                  <Command.Item className={itemCls} onSelect={run(() => openNote(null))}>
                    <Home />
                    <span className="flex-1">{t('nav.notes')}</span>
                    <Kbd>{modKey}1</Kbd>
                  </Command.Item>
                  <Command.Item className={itemCls} onSelect={run(() => setView('library'))}>
                    <Library />
                    <span className="flex-1">{t('nav.library')}</span>
                    <Kbd>{modKey}2</Kbd>
                  </Command.Item>
                  <Command.Item className={itemCls} onSelect={run(() => setView('trash'))}>
                    <Trash2 />
                    <span className="flex-1">{t('nav.trash')}</span>
                  </Command.Item>
                  <Command.Item className={itemCls} onSelect={run(() => setSettingsOpen(true))}>
                    <Settings />
                    <span className="flex-1">{t('nav.settings')}</span>
                    <Kbd>{modKey},</Kbd>
                  </Command.Item>
                </Command.Group>
              )}
              {notes.length > 0 && (
                <Command.Group heading={t('palette.notes')} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:text-subtle">
                  {notes.slice(0, 30).map((n) => (
                    <Command.Item key={n.id} value={n.id} className={itemCls} onSelect={run(() => openNote(n.id))}>
                      <NotebookText />
                      <span className="truncate">{n.title || t('common.untitled')}</span>
                      <span className="ml-auto max-w-[45%] truncate text-xs text-subtle">{n.excerpt}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
