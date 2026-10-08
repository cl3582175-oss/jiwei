import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Command } from 'cmdk'
import { Dialog as D } from 'radix-ui'
import { Library, Check, ChevronDown, Search, NotebookText, CircleSlash, ListChecks } from 'lucide-react'
import type { ChatScope } from '@shared/schemas'
import { useNotes, useSources } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/primitives'
import { KIND_ICON } from '../library/LibraryView'

/** 检索范围：全部知识库 / 指定笔记与资料 / 不使用知识库 */
export function ScopePicker({ value, onChange }: { value: ChatScope; onChange: (s: ChatScope) => void }) {
  const { t } = useTranslation()
  const [pickOpen, setPickOpen] = useState(false)
  const label =
    value.type === 'all'
      ? t('chat.scope.all')
      : value.type === 'none'
        ? t('chat.scope.none')
        : t('chat.scope.items', { count: value.notes.length + value.sources.length })
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs text-fg hover:bg-surface-hover"
            aria-label={t('chat.scope.label')}
          >
            {value.type === 'none' ? <CircleSlash className="size-3.5 text-subtle" /> : <Library className="size-3.5 text-accent" />}
            {label}
            <ChevronDown className="size-3 opacity-60" />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem onSelect={() => onChange({ type: 'all' })}>
            <Check className={cn(value.type !== 'all' && 'invisible')} />
            {t('chat.scope.all')}
          </MenuItem>
          <MenuItem onSelect={() => setPickOpen(true)}>
            <ListChecks />
            {t('chat.scope.pick')}
          </MenuItem>
          <MenuItem onSelect={() => onChange({ type: 'none' })}>
            <Check className={cn(value.type !== 'none' && 'invisible')} />
            {t('chat.scope.none')}
          </MenuItem>
        </MenuContent>
      </Menu>
      <ItemsDialog
        open={pickOpen}
        onOpenChange={setPickOpen}
        initial={value.type === 'items' ? value : { notes: [], sources: [] }}
        onDone={(v) => onChange({ type: 'items', ...v })}
      />
    </>
  )
}

function ItemsDialog({
  open,
  onOpenChange,
  initial,
  onDone
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  initial: { notes: string[]; sources: string[] }
  onDone: (v: { notes: string[]; sources: string[] }) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [notesSel, setNotes] = useState<Set<string>>(new Set(initial.notes))
  const [srcSel, setSrcs] = useState<Set<string>>(new Set(initial.sources))
  const { data: notes = [] } = useNotes({ search: q, limit: 50 })
  const { data: sources = [] } = useSources({ search: q })
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string): void => {
    const n = new Set(set)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setter(n)
  }
  const item =
    'flex h-9 cursor-default items-center gap-2.5 rounded-lg px-3 text-sm text-fg data-[selected=true]:bg-surface-hover [&_svg]:size-4 [&_svg]:shrink-0'
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]" />
        <D.Content className="fixed top-[14%] left-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-float outline-none">
          <D.Title className="px-5 pt-4 text-sm font-medium text-fg">{t('chat.scope.pickTitle')}</D.Title>
          <D.Description className="px-5 pt-1 text-xs text-muted">{t('chat.scope.pickDesc')}</D.Description>
          <Command shouldFilter={false} loop>
            <div className="mt-2 flex items-center gap-3 border-b border-border px-5">
              <Search className="size-4 text-subtle" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder={t('palette.placeholder')}
                className="h-11 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
              />
            </div>
            <Command.List className="max-h-[380px] overflow-y-auto p-2">
              <Command.Group
                heading={t('nav.notes')}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:text-subtle"
              >
                {notes.map((n) => (
                  <Command.Item key={n.id} value={`n:${n.id}`} onSelect={() => toggle(notesSel, setNotes, n.id)} className={item}>
                    <NotebookText className="text-subtle" />
                    <span className="flex-1 truncate">{n.title || t('common.untitled')}</span>
                    <Check className={cn('text-accent', !notesSel.has(n.id) && 'invisible')} />
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group
                heading={t('nav.library')}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:text-subtle"
              >
                {sources.map((s) => (
                  <Command.Item key={s.id} value={`s:${s.id}`} onSelect={() => toggle(srcSel, setSrcs, s.id)} className={item}>
                    <span className="text-subtle [&_svg]:size-4">{KIND_ICON[s.kind]}</span>
                    <span className="flex-1 truncate">{s.title}</span>
                    <Check className={cn('text-accent', !srcSel.has(s.id) && 'invisible')} />
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <span className="text-xs text-muted">{t('chat.scope.items', { count: notesSel.size + srcSel.size })}</span>
            <Button
              variant="primary"
              size="sm"
              disabled={notesSel.size + srcSel.size === 0}
              onClick={() => {
                onDone({ notes: [...notesSel], sources: [...srcSel] })
                onOpenChange(false)
              }}
            >
              {t('common.confirm')}
            </Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
