import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BookOpen,
  FileText,
  Film,
  Music,
  Image,
  File,
  Globe,
  FileType2,
  Layers,
  Upload,
  Link2,
  Search,
  X,
  MoreHorizontal,
  ExternalLink,
  FolderOpen,
  Pencil,
  Trash2,
  Folder,
  Inbox,
  Check
} from 'lucide-react'
import type { ImportResult, Source, SourceKind } from '@shared/types'
import { useCategories, useSources, invalidate } from '@/lib/queries'
import { api, cn, formatBytes, formatDate, formatRelative, fromDateInput, toDateInput } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tip,
  EmptyState
} from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { FloatingPanel } from '@/components/FloatingPanel'
import { CollapsibleSidebar } from '@/components/CollapsibleSidebar'
import { KIND_TINT } from '@/lib/tint'
import { InkLibrary } from '@/components/Illustrations'
import { useApp } from '@/store/app'
import { PanelLeftOpen } from 'lucide-react'
import { CategoryTree, SectionHeader, categoryPaths } from '../notes/CategoryTree'
import { TagEditor } from '../notes/TagEditor'

export const KIND_ICON: Record<SourceKind, ReactNode> = {
  book: <BookOpen />,
  pdf: <FileType2 />,
  video: <Film />,
  audio: <Music />,
  image: <Image />,
  document: <FileText />,
  web: <Globe />,
  other: <File />
}

const KINDS: SourceKind[] = ['book', 'pdf', 'video', 'audio', 'image', 'document', 'web', 'other']

type CatFilter = { type: 'all' } | { type: 'uncategorized' } | { type: 'category'; id: string }

function AddLinkDialog({
  open,
  onOpenChange,
  categoryId
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  categoryId: string | null
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const submit = async (): Promise<void> => {
    try {
      const u = new URL(url.trim())
      if (!/^https?:$/.test(u.protocol)) throw new Error()
    } catch {
      toast.error(t('library.invalidUrl'))
      return
    }
    await api.sources.addUrl(url.trim(), title, categoryId)
    invalidate(qc, 'sources', 'heatmap')
    setUrl('')
    setTitle('')
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('library.addLink')}>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input autoFocus placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t('library.linkUrl')} />
          <Input placeholder={t('library.linkTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!url.trim()}>
              {t('common.create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 资料信息：标题、作者、发布日期、标签 */
function SourceInfoDialog({ source: s, open, onOpenChange }: { source: Source; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [title, setTitle] = useState(s.title)
  const [author, setAuthor] = useState(s.author ?? '')
  const [published, setPublished] = useState(s.publishedAt ? toDateInput(s.publishedAt) : '')
  const save = async (): Promise<void> => {
    await api.sources.update(s.id, {
      title: title.trim() || s.title,
      author: author.trim() || null,
      publishedAt: published ? fromDateInput(published, new Date(2000, 0, 1, 12).getTime()) : null
    })
    invalidate(qc, 'sources')
    onOpenChange(false)
  }
  const field = (label: string, el: ReactNode): ReactNode => (
    <label className="block">
      <span className="mb-1.5 block text-xs text-muted">{label}</span>
      {el}
    </label>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('library.info')} className="w-[min(92vw,480px)]">
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {field(t('notes.titlePlaceholder'), <Input value={title} onChange={(e) => setTitle(e.target.value)} />)}
          <div className="grid grid-cols-2 gap-3">
            {field(t('library.author'), <Input value={author} onChange={(e) => setAuthor(e.target.value)} />)}
            {field(t('library.publishedAt'), <Input type="date" value={published} onChange={(e) => setPublished(e.target.value)} />)}
          </div>
          {field(t('tags.title'), <TagEditor entityType="source" entityId={s.id} tagIds={s.tagIds} />)}
          <p className="text-2xs text-subtle">
            {t('library.accessedAt')} {formatDate(s.accessedAt, i18n.language)}
            {s.originalName && <> · {s.originalName}</>}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary">
              {t('common.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SourceCard({ s }: { s: Source }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: cats = [] } = useCategories('source')
  const run = (p: Promise<unknown>): void => void p.catch((e) => toast.error(String(e)))

  const [infoOpen, setInfoOpen] = useState(false)
  const move = async (categoryId: string | null): Promise<void> => {
    await api.sources.update(s.id, { categoryId })
    invalidate(qc, 'sources')
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('library.deleteTitle'),
      description: t('library.deleteDesc'),
      confirmText: t('common.delete'),
      danger: true
    })
    if (!ok) return
    await api.sources.trash(s.id)
    invalidate(qc, 'sources', 'trash')
    toast(t('notes.deleted'))
  }

  return (
    <div
      onDoubleClick={() => useApp.getState().openSource(s.id)}
      className="paper group relative flex flex-col rounded-2xl p-4 shadow-[var(--shadow-1)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[var(--shadow-3)]"
    >
      <div className="flex items-start justify-between">
        <div data-tint={KIND_TINT[s.kind]} className="tint grid size-11 place-items-center rounded-xl [&_svg]:size-5">
          {KIND_ICON[s.kind]}
        </div>
        <Menu>
          <MenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
              aria-label={t('common.more')}
            >
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => useApp.getState().openSource(s.id)}>
              <PanelLeftOpen />
              {t('workspace.openInWorkspace')}
            </MenuItem>
            <MenuItem onSelect={() => run(api.sources.open(s.id))}>
              <ExternalLink />
              {t('workspace.openExternal')}
            </MenuItem>
            {s.kind !== 'web' && (
              <MenuItem onSelect={() => run(api.sources.reveal(s.id))}>
                <FolderOpen />
                {t('library.reveal')}
              </MenuItem>
            )}
            <MenuItem onSelect={() => setInfoOpen(true)}>
              <Pencil />
              {t('library.info')}
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <Folder />
                {t('notes.moveTo')}
              </MenuSubTrigger>
              <MenuSubContent>
                <MenuItem onSelect={() => void move(null)}>
                  <Check className={cn(s.categoryId !== null && 'invisible')} />
                  {t('common.uncategorized')}
                </MenuItem>
                {[...categoryPaths(cats)]
                  .sort((a, b) => a[1].localeCompare(b[1]))
                  .map(([id, path]) => (
                    <MenuItem key={id} onSelect={() => void move(id)}>
                      <Check className={cn(s.categoryId !== id && 'invisible')} />
                      {path}
                    </MenuItem>
                  ))}
              </MenuSubContent>
            </MenuSub>
            <MenuSeparator />
            <MenuItem danger onSelect={() => void remove()}>
              <Trash2 />
              {t('common.delete')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <p className="mt-4 line-clamp-2 text-sm leading-snug font-medium break-all text-fg" title={s.title}>
        {s.title}
      </p>
      <p className="mt-auto truncate pt-2 text-2xs text-subtle">
        {t(`library.kinds.${s.kind}`)} · {s.kind === 'web' ? new URL(s.url!).hostname : formatBytes(s.size)} ·{' '}
        {formatRelative(s.createdAt, i18n.language)}
      </p>
      <SourceInfoDialog source={s} open={infoOpen} onOpenChange={setInfoOpen} />
    </div>
  )
}

export function LibraryView() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [kind, setKind] = useState<SourceKind | undefined>()
  const [cat, setCat] = useState<CatFilter>({ type: 'all' })
  const [search, setSearch] = useState('')
  const [dragging, setDragging] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const categoryId = cat.type === 'all' ? undefined : cat.type === 'uncategorized' ? null : cat.id
  const { data: items = [], isFetched } = useSources({ kind, search, categoryId, includeDescendants: true })
  const targetCat = cat.type === 'category' ? cat.id : null

  const afterImport = (r: ImportResult): void => {
    if (r.imported.length > 0) toast.success(t('library.imported', { count: r.imported.length }))
    if (r.duplicates > 0) toast(t('library.duplicates', { count: r.duplicates }))
    invalidate(qc, 'sources', 'heatmap')
  }
  const importDialog = async (): Promise<void> => afterImport(await api.sources.importDialog(targetCat))
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => window.platform.pathForFile(f)).filter(Boolean)
    if (paths.length) afterImport(await api.sources.importPaths(paths, targetCat))
  }
  const row = (active: boolean, icon: ReactNode, label: ReactNode, onClick: () => void, trailing?: ReactNode): ReactNode => (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className={cn(
        'group flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors [&>svg]:size-4',
        active
          ? 'bg-surface text-fg shadow-card [&>svg]:text-accent'
          : 'text-muted hover:bg-surface-hover hover:text-fg [&>svg]:text-subtle'
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </div>
  )

  return (
    <div
      className="relative flex h-full"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      {/* 左栏：类型 + 分类 */}
      <CollapsibleSidebar>
        <aside className="flex h-full w-full flex-col">
          <div className="drag flex h-[52px] shrink-0 items-end px-4 pb-1.5">
            <h2 className="font-serif text-lg font-semibold tracking-wide text-fg">{t('library.title')}</h2>
          </div>
          <div className="space-y-0.5 overflow-y-auto px-3 pt-1">
            <SectionHeader label={t('library.typeHeader')} />
            {row(!kind, <Layers />, t('library.kinds.all'), () => setKind(undefined))}
            {KINDS.map((k) => (
              <div key={k}>{row(kind === k, KIND_ICON[k], t(`library.kinds.${k}`), () => setKind(k))}</div>
            ))}
            <CategoryTree
              kind="source"
              activeId={cat.type === 'category' ? cat.id : null}
              onSelect={(id) => setCat({ type: 'category', id })}
              onRemoved={(id) => cat.type === 'category' && cat.id === id && setCat({ type: 'all' })}
              leading={
                <div className="space-y-0.5">
                  {row(cat.type === 'all', <Layers />, t('library.allCategories'), () => setCat({ type: 'all' }))}
                  {row(cat.type === 'uncategorized', <Inbox />, t('common.uncategorized'), () => setCat({ type: 'uncategorized' }))}
                </div>
              }
            />
          </div>
        </aside>
      </CollapsibleSidebar>

      {/* 主区：浮动面板 */}
      <FloatingPanel flushLeft className="flex flex-col">
        <header className="drag flex h-[52px] shrink-0 items-center justify-end gap-2 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-6">
          <div className="no-drag relative w-[260px]">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('library.searchPlaceholder')}
              className="h-8 pl-8"
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
          <Tip label={t('library.addLink')} side="bottom">
            <Button
              variant="outline"
              size="icon"
              className="no-drag h-8 w-8"
              onClick={() => setLinkOpen(true)}
              aria-label={t('library.addLink')}
            >
              <Link2 />
            </Button>
          </Tip>
          <Button variant="primary" className="no-drag h-8" onClick={() => void importDialog()}>
            <Upload />
            {t('library.import')}
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isFetched && items.length === 0 ? (
            <EmptyState
              icon={<InkLibrary size={180} />}
              title={t('empty.libraryTitle')}
              hint={t('empty.libraryHint')}
              action={
                <Button variant="primary" onClick={() => void importDialog()}>
                  <Upload />
                  {t('library.import')}
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 p-8">
              {items.map((s) => (
                <SourceCard key={s.id} s={s} />
              ))}
            </div>
          )}
        </div>
      </FloatingPanel>

      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft backdrop-blur-[1px]">
          <div className="flex flex-col items-center gap-3 text-accent">
            <Upload className="size-8" />
            <p className="text-md font-medium">{t('library.dropHint')}</p>
          </div>
        </div>
      )}
      <AddLinkDialog open={linkOpen} onOpenChange={setLinkOpen} categoryId={targetCat} />
    </div>
  )
}
