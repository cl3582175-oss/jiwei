import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Popover } from 'radix-ui'
import { Command } from 'cmdk'
import { Hash, Plus, X, Check } from 'lucide-react'
import { useTags, invalidate } from '@/lib/queries'
import { api, cn } from '@/lib/utils'

/** 标签编辑：已有标签以小胶囊展示，点击 + 搜索或新建 */
export function TagEditor({ entityType, entityId, tagIds }: { entityType: 'note' | 'source'; entityId: string; tagIds: string[] }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: all = [] } = useTags()
  const [selected, setSelected] = useState(tagIds)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)

  const save = async (ids: string[]): Promise<void> => {
    setSelected(ids)
    await api.tags.set(entityType, entityId, ids)
    invalidate(qc, entityType === 'note' ? 'notes' : 'sources')
  }
  const toggle = (id: string): void => void save(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const create = async (): Promise<void> => {
    const tag = await api.tags.ensure(q)
    invalidate(qc, 'tags')
    setQ('')
    await save([...selected, tag.id])
  }

  const byId = new Map(all.map((tg) => [tg.id, tg]))
  const exact = all.some((tg) => tg.name.toLowerCase() === q.trim().replace(/^#/, '').toLowerCase())

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.map((id) => {
        const tag = byId.get(id)
        if (!tag) return null
        return (
          <span key={id} className="group inline-flex h-6 items-center gap-1 rounded-full bg-sunken pr-1.5 pl-2 text-xs text-muted">
            <Hash className="size-3 text-subtle" />
            {tag.name}
            <button
              onClick={() => toggle(id)}
              className="rounded-full text-subtle opacity-0 group-hover:opacity-100 hover:text-fg"
              aria-label={t('common.delete')}
            >
              <X className="size-3" />
            </button>
          </span>
        )
      })}
      <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), o || setQ(''))}>
        <Popover.Trigger asChild>
          <button className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border-strong px-2 text-xs text-subtle transition-colors hover:border-accent hover:text-accent">
            <Plus className="size-3" />
            {selected.length === 0 && t('tags.add')}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className="z-50 w-60 overflow-hidden rounded-lg border border-border bg-surface shadow-float data-[state=open]:animate-[pop-in_140ms_ease-out]"
          >
            <Command loop>
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder={t('tags.search')}
                className="h-9 w-full border-b border-border bg-transparent px-3 text-sm text-fg outline-none placeholder:text-subtle"
              />
              <Command.List className="max-h-56 overflow-y-auto p-1">
                {all.map((tg) => (
                  <Command.Item
                    key={tg.id}
                    value={tg.name}
                    onSelect={() => toggle(tg.id)}
                    className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-fg data-[selected=true]:bg-surface-hover"
                  >
                    <Hash className="size-3.5 text-subtle" />
                    <span className="flex-1 truncate">{tg.name}</span>
                    <Check className={cn('size-3.5 text-accent', !selected.includes(tg.id) && 'invisible')} />
                  </Command.Item>
                ))}
                {q.trim() && !exact && (
                  <Command.Item
                    value={`__create__${q}`}
                    onSelect={() => void create()}
                    className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-accent data-[selected=true]:bg-accent-soft"
                  >
                    <Plus className="size-3.5" />
                    {t('tags.create', { name: q.trim().replace(/^#/, '') })}
                  </Command.Item>
                )}
              </Command.List>
            </Command>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
