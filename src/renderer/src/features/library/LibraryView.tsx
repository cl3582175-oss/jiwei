import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BookOpen, FileText, Film, Music, Image, File, Globe, FileType2, Layers, Upload, Link2, Search, X,
  MoreHorizontal, ExternalLink, FolderOpen, Pencil, Trash2, Folder, Plus, Inbox, Check
} from 'lucide-react'
import type { Source, SourceKind } from '@shared/types'
import { useCategories, useSources, invalidate } from '@/lib/queries'
import { api, cn, formatBytes, formatRelative } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, Tip, EmptyState
} from '@/components/ui/primitives'
import { confirm, prompt } from '@/components/ui/confirm'

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

function AddLinkDialog({ open, onOpenChange, categoryId }: { open: boolean; onOpenChange: (o: boolean) => void; categoryId: string | null }) {
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

function SourceCard({ s }: { s: Source }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: cats = [] } = useCategories('source')
  const run = (p: Promise<unknown>): void => void p.catch((e) => toast.error(String(e)))

  const rename = async (): Promise<void> => {
    const title = await prompt({ title: t('common.rename'), defaultValue: s.title, confirmText: t('common.save') })
    if (!title) return
    await api.sources.update(s.id, { title })
    invalidate(qc, 'sources')
  }
  const move = async (categoryId: string | null): Promise<void> => {
    await api.sources.update(s.id, { categoryId })
    invalidate(qc, 'sources')
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm({ title: t('library.deleteTitle'), description: t('library.deleteDesc'), confirmText: t('common.delete'), danger: true })
    if (!ok) return
    await api.sources.trash(s.id)
    invalidate(qc, 'sources', 'trash')
    toast(t('notes.deleted'))
  }

  return (
    <div
      onDoubleClick={() => run(api.sources.open(s.id))}
      className="group relative flex flex-col rounded-xl border border-border bg-surface p-4 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-float"
    >
      <div className="flex items-start justify-between">
        <div className="grid size-11 place-items-center rounded-lg bg-accent-soft text-accent [&_svg]:size-5">{KIND_ICON[s.kind]}</div>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={t('common.more')}>
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => run(api.sources.open(s.id))}>
              <ExternalLink />
              {t('common.open')}
            </MenuItem>
            {s.kind !== 'web' && (
              <MenuItem onSelect={() => run(api.sources.reveal(s.id))}>
                <FolderOpen />
                {t('library.reveal')}
              </MenuItem>
            )}
            <MenuItem onSelect={() => void rename()}>
              <Pencil />
              {t('common.rename')}
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
                {cats.map((c) => (
                  <MenuItem key={c.id} onSelect={() => void move(c.id)}>
                    <Check className={cn(s.categoryId !== c.id && 'invisible')} />
                    {c.name}
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
        {t(`library.kinds.${s.kind}`)} · {s.kind === 'web' ? new URL(s.url!).hostname : formatBytes(s.size)} · {formatRelative(s.createdAt, i18n.language)}
      </p>
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
  const { data: cats = [] } = useCategories('source')
  const categoryId = cat.type === 'all' ? undefined : cat.type === 'uncategorized' ? null : cat.id
  const { data: items = [], isFetched } = useSources({ kind, search, categoryId })
  const targetCat = cat.type === 'category' ? cat.id : null

  const afterImport = (n: number): void => {
    if (n > 0) toast.success(t('library.imported', { count: n }))
    invalidate(qc, 'sources', 'heatmap')
  }
  const importDialog = async (): Promise<void> => afterImport((await api.sources.importDialog(targetCat)).length)
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => window.platform.pathForFile(f)).filter(Boolean)
    if (paths.length) afterImport((await api.sources.importPaths(paths, targetCat)).length)
  }
  const addCategory = async (): Promise<void> => {
    const name = await prompt({ title: t('notes.newCategory'), placeholder: t('notes.categoryName'), confirmText: t('common.create') })
    if (!name) return
    const c = await api.categories.create('source', name)
    invalidate(qc, 'categories')
    setCat({ type: 'category', id: c.id })
  }
  const removeCategory = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({ title: t('notes.deleteCategoryTitle', { name }), description: t('notes.deleteCategoryDesc'), confirmText: t('common.delete'), danger: true })
    if (!ok) return
    await api.categories.remove(id)
    setCat({ type: 'all' })
    invalidate(qc, 'categories', 'sources')
  }

  const row = (active: boolean, icon: ReactNode, label: ReactNode, onClick: () => void, trailing?: ReactNode): ReactNode => (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className={cn(
        'group flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors [&>svg]:size-4',
        active ? 'bg-surface text-fg shadow-card [&>svg]:text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg [&>svg]:text-subtle'
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
      <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-border bg-sunken/60">
        <div className="drag flex h-[52px] shrink-0 items-end px-4 pb-1.5">
          <h2 className="font-serif text-lg font-semibold tracking-wide text-fg">{t('library.title')}</h2>
        </div>
        <div className="space-y-0.5 overflow-y-auto px-3 pt-3">
          {row(!kind, <Layers />, t('library.kinds.all'), () => setKind(undefined))}
          {KINDS.map((k) => (
            <div key={k}>{row(kind === k, KIND_ICON[k], t(`library.kinds.${k}`), () => setKind(k))}</div>
          ))}
          <div className="flex items-center justify-between px-2 pt-5 pb-1">
            <span className="text-2xs font-medium tracking-wider text-subtle uppercase">{t('notes.categories')}</span>
            <button onClick={() => void addCategory()} className="rounded p-0.5 text-subtle hover:bg-surface-hover hover:text-fg" aria-label={t('notes.newCategory')}>
              <Plus className="size-3.5" />
            </button>
          </div>
          {row(cat.type === 'all', <Layers />, t('common.all'), () => setCat({ type: 'all' }))}
          {row(cat.type === 'uncategorized', <Inbox />, t('common.uncategorized'), () => setCat({ type: 'uncategorized' }))}
          {cats.map((c) => (
            <div key={c.id}>
              {row(
                cat.type === 'category' && cat.id === c.id,
                <Folder />,
                c.name,
                () => setCat({ type: 'category', id: c.id }),
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeCategory(c.id, c.name)
                  }}
                  className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger"
                  aria-label={t('common.delete')}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-[52px] shrink-0 items-center justify-end gap-2 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-6">
          <div className="no-drag relative w-[260px]">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('library.searchPlaceholder')} className="h-8 pl-8" />
            {search && (
              <button onClick={() => setSearch('')} className="absolute top-1/2 right-2 -translate-y-1/2 text-subtle hover:text-fg" aria-label="clear">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Tip label={t('library.addLink')} side="bottom">
            <Button variant="outline" size="icon" className="no-drag h-8 w-8" onClick={() => setLinkOpen(true)} aria-label={t('library.addLink')}>
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
              icon={<BookOpen />}
              title={t('library.empty')}
              hint={t('library.emptyHint')}
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
      </div>

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
