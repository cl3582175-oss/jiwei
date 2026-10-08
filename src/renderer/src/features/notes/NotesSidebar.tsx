import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Pin, Layers, Inbox, Folder, MoreHorizontal, ArrowDownUp, Check, Pencil, Trash2, X } from 'lucide-react'
import type { NoteQuery, NoteSort, NoteSummary } from '@shared/types'
import { useApp, type NoteFilter } from '@/store/app'
import { useCategories, useNotes, invalidate } from '@/lib/queries'
import { api, cn, formatRelative } from '@/lib/utils'
import { useCreateNote } from '@/lib/shortcuts'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '@/components/ui/primitives'
import { confirm, prompt } from '@/components/ui/confirm'

export function filterToQuery(f: NoteFilter): Pick<NoteQuery, 'categoryId' | 'pinnedOnly'> {
  switch (f.type) {
    case 'pinned':
      return { pinnedOnly: true }
    case 'uncategorized':
      return { categoryId: null }
    case 'category':
      return { categoryId: f.id }
    default:
      return {}
  }
}

function FilterRow({
  active,
  icon,
  label,
  onClick,
  trailing
}: {
  active: boolean
  icon: ReactNode
  label: ReactNode
  onClick: () => void
  trailing?: ReactNode
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      className={cn(
        'group flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
        active ? 'bg-surface text-fg shadow-card [&>svg]:text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg [&>svg]:text-subtle'
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </div>
  )
}

function NoteItem({ note, active, onClick }: { note: NoteSummary; active: boolean; onClick: () => void }) {
  const { t, i18n } = useTranslation()
  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative w-full rounded-lg px-3 py-2.5 text-left transition-colors',
        active ? 'bg-surface shadow-card' : 'hover:bg-surface-hover'
      )}
    >
      {active && <span className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-accent" />}
      <div className="flex items-center gap-1.5">
        {note.pinned && <Pin className="size-3 shrink-0 fill-accent text-accent" />}
        <span className={cn('truncate text-sm font-medium', note.title ? 'text-fg' : 'text-subtle')}>
          {note.title || t('common.untitled')}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs leading-[1.6] text-muted">{note.excerpt || ' '}</p>
      <p className="mt-1 text-2xs text-subtle">{formatRelative(note.updatedAt, i18n.language)}</p>
    </button>
  )
}

export function NotesSidebar() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { noteFilter, setNoteFilter, noteSort, setNoteSort, activeNoteId, openNote } = useApp()
  const [search, setSearch] = useState('')
  const createNote = useCreateNote()
  const { data: cats = [] } = useCategories('note')
  const { data: notes = [], isFetched } = useNotes({ ...filterToQuery(noteFilter), search, sort: noteSort })

  const addCategory = async (): Promise<void> => {
    const name = await prompt({ title: t('notes.newCategory'), placeholder: t('notes.categoryName'), confirmText: t('common.create') })
    if (!name) return
    const c = await api.categories.create('note', name)
    invalidate(qc, 'categories')
    setNoteFilter({ type: 'category', id: c.id })
  }

  const renameCategory = async (id: string, current: string): Promise<void> => {
    const name = await prompt({ title: t('common.rename'), defaultValue: current, confirmText: t('common.save') })
    if (!name) return
    await api.categories.rename(id, name)
    invalidate(qc, 'categories')
  }

  const removeCategory = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: t('notes.deleteCategoryTitle', { name }),
      description: t('notes.deleteCategoryDesc'),
      confirmText: t('common.delete'),
      danger: true
    })
    if (!ok) return
    await api.categories.remove(id)
    if (noteFilter.type === 'category' && noteFilter.id === id) setNoteFilter({ type: 'all' })
    invalidate(qc, 'categories', 'notes', 'sources')
  }

  const is = (f: NoteFilter): boolean =>
    f.type === noteFilter.type && (f.type !== 'category' || (noteFilter.type === 'category' && noteFilter.id === f.id))

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-border bg-sunken/60">
      {/* 标题栏（可拖拽窗口） */}
      <div className="drag flex h-[52px] shrink-0 items-end justify-between px-4 pb-1.5">
        <h2 className="font-serif text-lg font-semibold tracking-wide text-fg">{t('notes.title')}</h2>
        <div className="no-drag flex items-center gap-0.5">
          <Menu>
            <Tip label={t(`notes.sort.${noteSort}`)} side="bottom">
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="sort">
                  <ArrowDownUp />
                </Button>
              </MenuTrigger>
            </Tip>
            <MenuContent>
              {(['updated', 'created', 'title'] as NoteSort[]).map((s) => (
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

      {/* 搜索 */}
      <div className="px-3 pt-2 pb-3">
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
            <button
              onClick={() => setSearch('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-subtle hover:text-fg"
              aria-label="clear"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 目录：全部 / 置顶 / 分类 */}
      <div className="space-y-0.5 px-3">
        <FilterRow active={is({ type: 'all' })} icon={<Layers />} label={t('notes.all')} onClick={() => setNoteFilter({ type: 'all' })} />
        <FilterRow active={is({ type: 'pinned' })} icon={<Pin />} label={t('notes.pinned')} onClick={() => setNoteFilter({ type: 'pinned' })} />
        <FilterRow
          active={is({ type: 'uncategorized' })}
          icon={<Inbox />}
          label={t('common.uncategorized')}
          onClick={() => setNoteFilter({ type: 'uncategorized' })}
        />
      </div>
      <div className="mt-4 flex items-center justify-between px-5 pb-1">
        <span className="text-2xs font-medium tracking-wider text-subtle uppercase">{t('notes.categories')}</span>
        <Tip label={t('notes.newCategory')} side="bottom">
          <button onClick={() => void addCategory()} className="rounded p-0.5 text-subtle hover:bg-surface-hover hover:text-fg" aria-label={t('notes.newCategory')}>
            <Plus className="size-3.5" />
          </button>
        </Tip>
      </div>
      <div className="max-h-[30%] space-y-0.5 overflow-y-auto px-3">
        {cats.map((c) => (
          <FilterRow
            key={c.id}
            active={is({ type: 'category', id: c.id })}
            icon={<Folder />}
            label={c.name}
            onClick={() => setNoteFilter({ type: 'category', id: c.id })}
            trailing={
              <Menu>
                <MenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <button className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-fg data-[state=open]:opacity-100" aria-label={t('common.more')}>
                    <MoreHorizontal className="size-4" />
                  </button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => void renameCategory(c.id, c.name)}>
                    <Pencil />
                    {t('common.rename')}
                  </MenuItem>
                  <MenuItem danger onSelect={() => void removeCategory(c.id, c.name)}>
                    <Trash2 />
                    {t('common.delete')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            }
          />
        ))}
      </div>

      {/* 笔记列表 */}
      <div className="mx-5 mt-3 mb-2 h-px bg-border" />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {notes.map((n) => (
          <NoteItem key={n.id} note={n} active={n.id === activeNoteId} onClick={() => openNote(n.id)} />
        ))}
        {isFetched && notes.length === 0 && (
          <p className="px-3 py-8 text-center text-xs text-subtle">{search ? t('notes.noResults') : t('notes.empty')}</p>
        )}
      </div>
    </aside>
  )
}

