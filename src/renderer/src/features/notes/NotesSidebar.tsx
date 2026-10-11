import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { SidebarToggle } from '@/components/PageSidebar'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Pin, Layers, Inbox, ArrowDownUp, Check, X, Hash, Trash2, ShieldOff, MoreHorizontal, Folder } from 'lucide-react'
import type { NoteQuery, NoteSort, NoteSummary } from '@shared/types'
import { useApp, type NoteFilter } from '@/store/app'
import { useNotes, useTags, invalidate } from '@/lib/queries'
import { api, cn, formatDate, formatRelative, modKey } from '@/lib/utils'
import { useCreateNote } from '@/lib/shortcuts'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { CategoryTree, FilterRow, NOTE_DRAG_TYPE, SectionHeader } from './CategoryTree'
import { NoteMenuItems, useNoteActions } from './NoteMenu'
import { STATUS_META } from './NoteEditor'
import { InkMountains } from '@/components/Illustrations'

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

function NoteItem({
  note,
  active,
  selected,
  sort,
  targets,
  onClick
}: {
  note: NoteSummary
  active: boolean
  selected: boolean
  sort: NoteSort
  /** 菜单与拖动作用的笔记：这篇在多选中时为全部已选，否则只有这篇 */
  targets: NoteSummary[]
  onClick: (e: MouseEvent) => void
}) {
  const { t, i18n } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const time =
    sort === 'learned'
      ? formatDate(note.learnedAt, i18n.language)
      : sort === 'created'
        ? formatDate(note.createdAt, i18n.language)
        : formatRelative(note.editedAt, i18n.language)
  return (
    <div
      role="button"
      tabIndex={0}
      data-note-id={note.id}
      aria-selected={selected}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(NOTE_DRAG_TYPE, JSON.stringify(targets.map((n) => n.id)))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick(e as unknown as MouseEvent)}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
      className={cn(
        'group relative w-full cursor-default rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        selected ? 'bg-accent-soft/70 ring-1 ring-accent/30' : active ? 'bg-surface shadow-card' : 'hover:bg-surface-hover'
      )}
    >
      {active && <span className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-accent" />}
      <div className="flex items-center gap-1.5 pr-6">
        {note.pinned && <Pin className="size-3 shrink-0 fill-accent text-accent" />}
        {note.status !== 'active' && (
          <span className={cn('shrink-0 [&_svg]:size-3', STATUS_META[note.status].cls)}>{STATUS_META[note.status].icon}</span>
        )}
        <span
          className={cn(
            'truncate text-sm font-medium',
            note.title ? 'text-fg' : 'text-subtle',
            note.status === 'outdated' && 'text-muted line-through decoration-subtle/60'
          )}
        >
          {note.title || t('common.untitled')}
        </span>
        {note.aiExcluded && <ShieldOff className="ml-auto size-3 shrink-0 text-subtle" />}
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs leading-[1.6] text-muted">{note.excerpt || ' '}</p>
      <p className="mt-1 text-2xs text-subtle">{time}</p>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            aria-label={t('notes.noteActions')}
            className={cn(
              'absolute top-2 right-1.5 grid size-6 place-items-center rounded-md text-subtle transition-opacity hover:bg-surface-hover hover:text-fg [&_svg]:size-4',
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
            )}
          >
            <MoreHorizontal />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <NoteMenuItems notes={targets} />
        </MenuContent>
      </Menu>
    </div>
  )
}

/** 多选时的操作条：移动、删除、取消 */
function BulkBar({ notes, onClear }: { notes: NoteSummary[]; onClear: () => void }) {
  const { t } = useTranslation()
  const { paths, move, remove } = useNoteActions()
  const ids = notes.map((n) => n.id)
  return (
    <div
      className="mx-2 mb-2 flex shrink-0 items-center gap-1 rounded-xl border border-border bg-surface px-2.5 py-1.5 shadow-float"
      data-testid="notes-bulk"
    >
      <span className="flex-1 text-xs text-fg">{t('notes.selected', { count: notes.length })}</span>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 px-2">
            <Folder />
            {t('notes.moveTo')}
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => void move(ids, null).then(onClear)}>
            <Inbox />
            {t('common.uncategorized')}
          </MenuItem>
          {[...paths]
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([id, path]) => (
              <MenuItem key={id} onSelect={() => void move(ids, id).then(onClear)}>
                <Folder />
                {path}
              </MenuItem>
            ))}
        </MenuContent>
      </Menu>
      <Tip label={t('common.delete')}>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('common.delete')}
          onClick={() => void remove(ids).then((ok) => ok && onClear())}
        >
          <Trash2 />
        </Button>
      </Tip>
      <Tip label={t('notes.clearSelection')}>
        <Button size="icon-sm" variant="ghost" aria-label={t('notes.clearSelection')} onClick={onClear}>
          <X />
        </Button>
      </Tip>
    </div>
  )
}

export function NotesSidebar() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { noteFilter, setNoteFilter, noteSort, setNoteSort, noteId: activeNoteId, openNote } = useApp()
  const [search, setSearch] = useState('')
  const createNote = useCreateNote()
  const { data: tags = [] } = useTags()
  const { data: notes = [], isFetched } = useNotes({ ...filterToQuery(noteFilter), search, sort: noteSort })
  const { move } = useNoteActions()
  // 多选（v0.7.6）：⌘ 点选、Shift 连选；换筛选或按 Esc 清空
  const selected = useApp((s) => s.noteSelection)
  const setSelected = useApp((s) => s.setNoteSelection)
  const anchor = useRef<string | null>(null)
  useEffect(() => setSelected([]), [search, setSelected])
  useEffect(() => {
    if (!selected.length) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelected([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected.length, setSelected])
  const visible = new Set(notes.map((n) => n.id))
  const picked = notes.filter((n) => selected.includes(n.id))
  const clickNote = (e: MouseEvent, n: NoteSummary): void => {
    if (e.metaKey || e.ctrlKey) {
      const base = selected.length ? selected : activeNoteId && visible.has(activeNoteId) ? [activeNoteId] : []
      setSelected(base.includes(n.id) ? base.filter((x) => x !== n.id) : [...base, n.id])
      anchor.current = n.id
      return
    }
    if (e.shiftKey) {
      const from = notes.findIndex((x) => x.id === (anchor.current ?? activeNoteId))
      const to = notes.findIndex((x) => x.id === n.id)
      if (from >= 0 && to >= 0) {
        setSelected(notes.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.id))
        return
      }
    }
    setSelected([])
    anchor.current = n.id
    openNote(n.id)
  }
  const dropTo = (categoryId: string | null) => (ids: string[]) => void move(ids, categoryId).then(() => setSelected([]))

  const is = (f: NoteFilter): boolean => f.type === noteFilter.type && (!('id' in f) || ('id' in noteFilter && noteFilter.id === f.id))

  const removeTag = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: t('tags.deleteTitle', { name }),
      description: t('tags.deleteDesc'),
      confirmText: t('common.delete'),
      danger: true
    })
    if (!ok) return
    await api.tags.remove(id)
    if (noteFilter.type === 'tag' && noteFilter.id === id) setNoteFilter({ type: 'all' })
    invalidate(qc, 'tags', 'notes')
  }

  return (
    <aside className="flex h-full w-full flex-col">
      <div className="drag flex h-[52px] shrink-0 items-end justify-between px-4 pb-1.5">
        <h2 className="font-serif text-lg font-semibold tracking-wide text-fg">{t('notes.title')}</h2>
        <div className="no-drag flex items-center gap-0.5">
          <SidebarToggle />
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
          <Tip label={`${t('notes.new')}  ${modKey}N`} side="bottom">
            <Button
              variant="outline"
              size="sm"
              className="ml-1 h-7 rounded-full px-2.5"
              onClick={() => void createNote()}
              aria-label={t('notes.new')}
            >
              <Plus />
              {t('common.create')}
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
            <button
              onClick={() => setSearch('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-subtle hover:text-fg"
              aria-label={t('common.clear')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 目录：全部 / 置顶 / 未分类 / 分类树 / 标签 */}
      <div className="max-h-[42%] shrink-0 overflow-y-auto px-3 pb-1">
        <div className="space-y-0.5">
          <FilterRow active={is({ type: 'all' })} icon={<Layers />} label={t('notes.all')} onClick={() => setNoteFilter({ type: 'all' })} />
          <FilterRow
            active={is({ type: 'pinned' })}
            icon={<Pin />}
            label={t('notes.pinned')}
            onClick={() => setNoteFilter({ type: 'pinned' })}
          />
          <FilterRow
            active={is({ type: 'uncategorized' })}
            icon={<Inbox />}
            label={t('common.uncategorized')}
            onClick={() => setNoteFilter({ type: 'uncategorized' })}
            onDropNotes={dropTo(null)}
          />
        </div>
        <CategoryTree
          kind="note"
          activeId={noteFilter.type === 'category' ? noteFilter.id : null}
          onSelect={(id) => setNoteFilter({ type: 'category', id })}
          onRemoved={(id) => noteFilter.type === 'category' && noteFilter.id === id && setNoteFilter({ type: 'all' })}
          onDropNotes={(id, ids) => dropTo(id)(ids)}
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
          <NoteItem
            key={n.id}
            note={n}
            sort={noteSort}
            active={n.id === activeNoteId}
            selected={selected.includes(n.id) && selected.length > 1}
            targets={selected.includes(n.id) && picked.length > 1 ? picked : [n]}
            onClick={(e) => clickNote(e, n)}
          />
        ))}
        {isFetched && notes.length === 0 && (
          <div className="flex flex-col items-center px-3 py-8 text-center">
            {search && <InkMountains size={110} className="mb-3 text-subtle" />}
            <p className="text-xs text-subtle">{search ? t('notes.noResults') : t('notes.empty')}</p>
          </div>
        )}
      </div>
      {picked.length > 1 && <BulkBar notes={picked} onClear={() => setSelected([])} />}
    </aside>
  )
}
