import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronRight, Folder, FolderOpen, MoreHorizontal, Pencil, Trash2, FolderPlus } from 'lucide-react'
import type { Category, CategoryKind } from '@shared/types'
import { useCategories, invalidate } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/primitives'
import { prompt } from '@/components/ui/confirm'

/** 分类 ID → “父 / 子 / 孙” 路径名 */
export function categoryPaths(cats: Category[]): Map<string, string> {
  const byId = new Map(cats.map((c) => [c.id, c]))
  const out = new Map<string, string>()
  for (const c of cats) {
    const parts: string[] = []
    let cur: Category | undefined = c
    const guard = new Set<string>()
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id)
      parts.unshift(cur.name)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    out.set(c.id, parts.join(' / '))
  }
  return out
}

/** 侧栏筛选行（全部 / 置顶 / 分类 / 标签 共用样式） */
export function FilterRow({
  active,
  icon,
  label,
  onClick,
  trailing,
  depth = 0,
  leading
}: {
  active: boolean
  icon: ReactNode
  label: ReactNode
  onClick: () => void
  trailing?: ReactNode
  depth?: number
  leading?: ReactNode
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      style={{ paddingLeft: 10 + depth * 16 }}
      className={cn(
        'group flex h-8 cursor-default items-center gap-2 rounded-md pr-2 text-sm transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
        active ? 'bg-surface text-fg shadow-card [&>svg]:text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg [&>svg]:text-subtle'
      )}
    >
      {leading}
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </div>
  )
}

interface TreeProps {
  kind: CategoryKind
  activeId: string | null
  onSelect: (id: string) => void
  /** 分类被删除后回调（用于重置筛选） */
  onRemoved?: (id: string) => void
}

export function CategoryTree({ kind, activeId, onSelect, onRemoved }: TreeProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: cats = [] } = useCategories(kind)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const children = (parentId: string | null): Category[] =>
    cats.filter((c) => (c.parentId ?? null) === parentId || (parentId === null && c.parentId && !cats.some((p) => p.id === c.parentId)))

  const add = async (parentId: string | null): Promise<void> => {
    const name = await prompt({ title: parentId ? t('categories.newSub') : t('notes.newCategory'), placeholder: t('notes.categoryName'), confirmText: t('common.create') })
    if (!name) return
    const c = await api.categories.create(kind, name, parentId)
    invalidate(qc, 'categories')
    if (parentId) setCollapsed((s) => (s.delete(parentId), new Set(s)))
    onSelect(c.id)
  }
  const rename = async (c: Category): Promise<void> => {
    const name = await prompt({ title: t('common.rename'), defaultValue: c.name, confirmText: t('common.save') })
    if (!name) return
    await api.categories.update(c.id, { name })
    invalidate(qc, 'categories')
  }
  const remove = async (c: Category): Promise<void> => {
    await api.categories.remove(c.id)
    invalidate(qc, 'categories', 'notes', 'sources', 'trash')
    onRemoved?.(c.id)
    toast(t('categories.removed', { name: c.name }), {
      action: {
        label: t('common.undo'),
        onClick: () => void api.trash.restore('category', c.id).then(() => invalidate(qc, 'categories', 'notes', 'sources', 'trash'))
      }
    })
  }

  const render = (c: Category, depth: number): ReactNode => {
    const kids = children(c.id)
    const open = !collapsed.has(c.id)
    return (
      <div key={c.id}>
        <FilterRow
          depth={depth}
          active={activeId === c.id}
          onClick={() => onSelect(c.id)}
          leading={
            <button
              onClick={(e) => {
                e.stopPropagation()
                setCollapsed((s) => (s.has(c.id) ? s.delete(c.id) : s.add(c.id), new Set(s)))
              }}
              className={cn('-ml-1 grid size-4 place-items-center rounded text-subtle hover:text-fg', kids.length === 0 && 'invisible')}
              aria-label="toggle"
            >
              <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
            </button>
          }
          icon={activeId === c.id ? <FolderOpen /> : <Folder />}
          label={c.name}
          trailing={
            <Menu>
              <MenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <button className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-fg data-[state=open]:opacity-100" aria-label={t('common.more')}>
                  <MoreHorizontal className="size-4" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => void add(c.id)}>
                  <FolderPlus />
                  {t('categories.newSub')}
                </MenuItem>
                <MenuItem onSelect={() => void rename(c)}>
                  <Pencil />
                  {t('common.rename')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={() => void remove(c)}>
                  <Trash2 />
                  {t('common.delete')}
                </MenuItem>
              </MenuContent>
            </Menu>
          }
        />
        {open && kids.map((k) => render(k, depth + 1))}
      </div>
    )
  }

  return (
    <>
      <SectionHeader label={t('notes.categories')} onAdd={() => void add(null)} addLabel={t('notes.newCategory')} />
      <div className="space-y-0.5">{children(null).map((c) => render(c, 0))}</div>
    </>
  )
}

export function SectionHeader({ label, onAdd, addLabel }: { label: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div className="flex items-center justify-between px-2 pt-4 pb-1">
      <span className="text-2xs font-medium tracking-wider text-subtle uppercase">{label}</span>
      {onAdd && (
        <button onClick={onAdd} className="rounded p-0.5 text-subtle hover:bg-surface-hover hover:text-fg" aria-label={addLabel}>
          <FolderPlus className="size-3.5" />
        </button>
      )}
    </div>
  )
}
