import { Button } from '@/components/ui/shadcn-button'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { PopoverParts as Popover } from '@/components/ui/popover'
import { CommandParts as Command } from '@/components/ui/command'
import { Hash, Plus, X, Check } from 'lucide-react'
import { useTags, invalidate } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import { tintFor } from '@/lib/tint'

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
          <span
            key={id}
            data-tint={tintFor(tag.id, tag.color)}
            className="tint group inline-flex h-6 items-center gap-1 rounded-full pr-1.5 pl-2 text-xs"
          >
            <Hash className="size-3 opacity-60" />
            {tag.name}
            <Button variant="ghost" size="auto"
              onClick={() => toggle(id)}
              className="rounded-full opacity-0 group-hover:opacity-70 hover:opacity-100"
              aria-label={t('common.delete')}
            >
              <X className="size-3" />
            </Button>
          </span>
        )
      })}
      <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), o || setQ(''))}>
        <Popover.Trigger asChild>
          <Button variant="ghost" size="auto" className="inline-flex h-6 items-center gap-1 rounded-full bg-secondary px-2 text-xs text-subtle transition-colors hover:border-accent hover:text-accent">
            <Plus className="size-3" />
            {selected.length === 0 && t('tags.add')}
          </Button>
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
                <Command.Group>
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
              </Command.Group>
              </Command.List>
            </Command>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
