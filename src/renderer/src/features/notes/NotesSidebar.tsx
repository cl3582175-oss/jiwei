import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Pin, Layers, Inbox, ArrowDownUp, Check, X, Hash, Trash2, ShieldOff } from 'lucide-react'
import type { NoteQuery, NoteSort, NoteSummary } from '@shared/types'
import { useApp, type NoteFilter } from '@/store/app'
import { useNotes, useTags, invalidate } from '@/lib/queries'
import { api, cn, formatDate, formatRelative } from '@/lib/utils'
import { useCreateNote } from '@/lib/shortcuts'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { CategoryTree, FilterRow, SectionHeader } from './CategoryTree'
import { STATUS_META } from './NoteEditor'

export function filterToQuery(f: NoteFilter): Pick<NoteQuery, 'categoryId' | 'pinnedOnly' | 'tagId' | 'includeDescendants'> {
  switch (f.type) {
    case 'pinned':
      return { pinnedOnly: true }
    case 'uncategorized':
      return { categoryId: null }
    case 'category':
      return { categoryId: f.id, includeDescendants: true }
    case 'tag':
      return { tagId: f.id }
    default:
      return {}
  }
}

function NoteItem({ note, active, sort, onClick }: { note: NoteSummary; active: boolean; sort: NoteSort; onClick: () => void }) {
  const { t, i18n } = useTranslation()
  const time =
    sort === 'learned'
      ? formatDate(note.learnedAt, i18n.language)
      : sort === 'created'
        ? formatDate(note.createdAt, i18n.language)
        : formatRelative(note.editedAt, i18n.language)
  return (
    <button
      onClick={onClick}
      className={cn('group relative w-full rounded-lg px-3 py-2.5 text-left transition-colors', active ? 'bg-surface shadow-card' : 'hover:bg-surface-hover')}
    >
      {active && <span className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-accent" />}
      <div className="flex items-center gap-1.5">
        {note.pinned && <Pin className="size-3 shrink-0 fill-accent text-accent" />}
        {note.status !== 'active' && <span className={cn('shrink-0 [&_svg]:size-3', STATUS_META[note.status].cls)}>{STATUS_META[note.status].icon}</span>}
        <span className={cn('truncate text-sm font-medium', note.title ? 'text-fg' : 'text-subtle', note.status === 'outdated' && 'text-muted line-through decoration-subtle/60')}>
          {note.title || t('common.untitled')}
        </span>
        {note.aiExcluded && <ShieldOff className="ml-auto size-3 shrink-0 text-subtle" />}
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs leading-[1.6] text-muted">{note.excerpt || ' '}</p>
      <p className="mt-1 text-2xs text-subtle">{time}</p>
    </button>
  )
}

export function NotesSidebar() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { noteFilter, setNoteFilter, noteSort, setNoteSort, activeNoteId, openNote } = useApp()
  const [search, setSearch] = useState('')
  const createNote = useCreateNote()
  const { data: tags = [] } = useTags()
  const { data: notes = [], isFetched } = useNotes({ ...filterToQuery(noteFilter), search, sort: noteSort })

  const is = (f: NoteFilter): boolean => f.type === noteFilter.type && (!('id' in f) || ('id' in noteFilter && noteFilter.id === f.id))

  const removeTag = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({ title: t('tags.deleteTitle', { name }), description: t('tags.deleteDesc'), confirmText: t('common.delete'), danger: true })
    if (!ok) return
    await api.tags.remove(id)
    if (noteFilter.type === 'tag' && noteFilter.id === id) setNoteFilter({ type: 'all' })
    invalidate(qc, 'tags', 'notes')
  }

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-border bg-sunken/60">
      <div className="drag flex h-[52px] shrink-0 items-end justify-between px-4 pb-1.5">
        <h2 className="font-serif text-lg font-semibold tracking-wide text-fg">{t('notes.title')}</h2>
        <div className="no-drag flex items-center gap-0.5">
          <Menu>
            <Tip label={t(`notes.sort.${noteSort}`)} side="bottom">
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('notes.sortLabel')}>
                  <ArrowDownUp />
                </Button>
              </MenuTrigger>
            </Tip>
            <MenuContent>
              {(['edited', 'learned', 'created', 'title'] as NoteSort[]).map((s) => (
                <MenuItem key={s} onSelect={() => setNoteSort(s)}>
                  <Check className={cn(noteSort !== s && 'invisible')} />
                  {t(`notes.sort.${s}`)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <Tip label={t('notes.new')} side="bottom">
            <Button variant="ghost" size="icon-sm" onClick={() => void createNote()} aria-label={t('notes.new')}>
              <Plus />
            </Button>
          </Tip>
        </div>
      </div>

      <div className="px-3 pt-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
            placeholder={t('notes.searchPlaceholder')}
            className="h-8 w-full rounded-md border border-transparent bg-surface pr-7 pl-8 text-sm text-fg shadow-card outline-none placeholder:text-subtle focus:border-accent focus:ring-3 focus:ring-accent-soft"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute top-1/2 right-2 -translate-y-1/2 text-subtle hover:text-fg" aria-label={t('common.clear')}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 目录：全部 / 置顶 / 未分类 / 分类树 / 标签 */}
      <div className="max-h-[42%] shrink-0 overflow-y-auto px-3 pb-1">
        <div className="space-y-0.5">
          <FilterRow active={is({ type: 'all' })} icon={<Layers />} label={t('notes.all')} onClick={() => setNoteFilter({ type: 'all' })} />
          <FilterRow active={is({ type: 'pinned' })} icon={<Pin />} label={t('notes.pinned')} onClick={() => setNoteFilter({ type: 'pinned' })} />
          <FilterRow active={is({ type: 'uncategorized' })} icon={<Inbox />} label={t('common.uncategorized')} onClick={() => setNoteFilter({ type: 'uncategorized' })} />
        </div>
        <CategoryTree
          kind="note"
          activeId={noteFilter.type === 'category' ? noteFilter.id : null}
          onSelect={(id) => setNoteFilter({ type: 'category', id })}
          onRemoved={(id) => noteFilter.type === 'category' && noteFilter.id === id && setNoteFilter({ type: 'all' })}
        />
        {tags.length > 0 && (
          <>
            <SectionHeader label={t('tags.title')} />
            <div className="space-y-0.5">
              {tags.map((tg) => (
                <FilterRow
                  key={tg.id}
                  active={is({ type: 'tag', id: tg.id })}
                  icon={<Hash />}
                  label={tg.name}
                  onClick={() => setNoteFilter({ type: 'tag', id: tg.id })}
                  trailing={
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeTag(tg.id, tg.name)
                      }}
                      className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="mx-5 mt-2 mb-2 h-px shrink-0 bg-border" />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {notes.map((n) => (
          <NoteItem key={n.id} note={n} sort={noteSort} active={n.id === activeNoteId} onClick={() => openNote(n.id)} />
        ))}
        {isFetched && notes.length === 0 && (
          <p className="px-3 py-8 text-center text-xs text-subtle">{search ? t('notes.noResults') : t('notes.empty')}</p>
        )}
      </div>
    </aside>
  )
}
