import { Button } from '@/components/ui/shadcn-button'
import { useState, type DragEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronRight, Folder, FolderOpen, MoreHorizontal, Pencil, Trash2, FolderPlus, Palette } from 'lucide-react'
import { TINTS, tintFor } from '@/lib/tint'
import type { Category, CategoryKind } from '@shared/types'
import { useCategories, invalidate } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger
} from '@/components/ui/shadcn-primitives'
import { prompt, useConfirmSignal, withActionLock } from '@/components/ui/shadcn-confirm'

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

/** 拖动笔记时的数据类型（v0.7.6：把笔记拖到分类上即移动） */
export const NOTE_DRAG_TYPE = 'application/x-jiwei-notes'

/** 侧栏筛选行（全部 / 置顶 / 分类 / 标签 共用样式） */
export function FilterRow({
  active,
  icon,
  label,
  onClick,
  trailing,
  depth = 0,
  leading,
  onDropNotes
}: {
  active: boolean
  icon: ReactNode
  label: ReactNode
  onClick: () => void
  trailing?: ReactNode
  depth?: number
  leading?: ReactNode
  /** 可以把笔记拖到这一行上（分类、未分类） */
  onDropNotes?: (ids: string[]) => void
}) {
  const [over, setOver] = useState(false)
  const accepts = (e: DragEvent): boolean => !!onDropNotes && e.dataTransfer.types.includes(NOTE_DRAG_TYPE)
  return (
    <div
      role="button"
      tabIndex={0}
      onDragOver={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (!accepts(e)) return
        e.preventDefault()
        try {
          onDropNotes!(JSON.parse(e.dataTransfer.getData(NOTE_DRAG_TYPE)) as string[])
        } catch {
          /* 不是笔记 */
        }
      }}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      style={{ paddingLeft: 10 + depth * 16 }}
      className={cn(
        'group flex h-8 cursor-default items-center gap-2 rounded-md pr-2 text-sm transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
        over && 'bg-accent-soft ring-1 ring-accent/50',
        active
          ? 'bg-surface text-fg shadow-card [&>svg]:text-accent'
          : 'text-muted hover:bg-surface-hover hover:text-fg [&>svg]:text-subtle'
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
  /** 显示在“分类”标题下方、分类列表之前的固定行 */
  leading?: ReactNode
  /** 把笔记拖到分类上（v0.7.6） */
  onDropNotes?: (categoryId: string, ids: string[]) => void
}

export function CategoryTree({ kind, activeId, onSelect, onRemoved, leading, onDropNotes }: TreeProps) {
  const confirmSignal = useConfirmSignal(kind)
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: cats = [] } = useCategories(kind)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const children = (parentId: string | null): Category[] =>
    cats.filter((c) => (c.parentId ?? null) === parentId || (parentId === null && c.parentId && !cats.some((p) => p.id === c.parentId)))

  const add = async (parentId: string | null): Promise<void> => {
    const operationKey = `category:${kind}:${parentId ?? 'root'}:create`
    await withActionLock(operationKey, async () => {
      const created: { id?: string } = {}
      const name = await prompt({
        operationKey,
        signal: confirmSignal,
        title: parentId ? t('categories.newSub') : t('notes.newCategory'),
        placeholder: t('notes.categoryName'),
        confirmText: t('common.create'),
        submit: async (value) => { created.id = (await api.categories.create(kind, value, parentId)).id }
      })
      if (!name || confirmSignal.aborted || !created.id) return
      invalidate(qc, 'categories')
      if (parentId) setCollapsed((s) => (s.delete(parentId), new Set(s)))
      onSelect(created.id)
    }, { signal: confirmSignal })
  }
  const rename = async (c: Category): Promise<void> => {
    const operationKey = `category:${c.id}:rename`
    await withActionLock(operationKey, async () => {
      const name = await prompt({ title: t('common.rename'), defaultValue: c.name, confirmText: t('common.save'), operationKey, signal: confirmSignal,
        submit: async (value) => { await api.categories.update(c.id, { name: value }) }
      })
      if (!name || confirmSignal.aborted) return
      invalidate(qc, 'categories')
    }, { signal: confirmSignal })
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
          onDropNotes={onDropNotes ? (ids) => onDropNotes(c.id, ids) : undefined}
          leading={
            <Button variant="ghost" size="auto"
              onClick={(e) => {
                e.stopPropagation()
                setCollapsed((s) => (s.has(c.id) ? s.delete(c.id) : s.add(c.id), new Set(s)))
              }}
              className={cn('-ml-1 grid size-4 place-items-center rounded text-subtle hover:text-fg', kids.length === 0 && 'invisible')}
              aria-label="toggle"
            >
              <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
            </Button>
          }
          icon={
            <span data-tint={tintFor(c.id, c.color)} className="grid size-4 shrink-0 place-items-center">
              {activeId === c.id ? (
                <FolderOpen className="tint-ink size-4" style={{ fill: 'var(--tint)' }} />
              ) : (
                <Folder className="tint-ink size-4" style={{ fill: 'var(--tint)' }} />
              )}
            </span>
          }
          label={c.name}
          trailing={
            <Menu>
              <MenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="auto"
                  className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-fg data-[state=open]:opacity-100"
                  aria-label={t('common.more')}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
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
                <MenuSub>
                  <MenuSubTrigger>
                    <Palette />
                    {t('categories.color')}
                  </MenuSubTrigger>
                  <MenuSubContent>
                    <div className="flex gap-1.5 p-1.5">
                      {TINTS.map((tn) => (
                        <Button variant="ghost" size="auto"
                          key={tn}
                          data-tint={tn}
                          title={t(`tints.${tn}`)}
                          aria-label={t(`tints.${tn}`)}
                          onClick={() => void api.categories.update(c.id, { color: tn }).then(() => invalidate(qc, 'categories'))}
                          className={cn(
                            'tint grid size-6 place-items-center rounded-full ring-offset-1 ring-offset-surface',
                            tintFor(c.id, c.color) === tn && 'ring-2 ring-[var(--tint-ink)]'
                          )}
                        >
                          <span className="tint-dot size-2 rounded-full" />
                        </Button>
                      ))}
                    </div>
                  </MenuSubContent>
                </MenuSub>
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
      {leading}
      <div className="space-y-0.5">{children(null).map((c) => render(c, 0))}</div>
    </>
  )
}

export function SectionHeader({ label, onAdd, addLabel }: { label: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div className="flex items-center justify-between px-2 pt-4 pb-1">
      <span className="text-2xs font-medium tracking-wider text-subtle uppercase">{label}</span>
      {onAdd && (
        <Button variant="ghost" size="auto" onClick={onAdd} className="rounded p-0.5 text-subtle hover:bg-surface-hover hover:text-fg" aria-label={addLabel}>
          <FolderPlus className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
