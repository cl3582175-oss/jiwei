import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronRight,
  FolderInput,
  FolderMinus,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  PanelsTopLeft,
  Pencil,
  Pin,
  PinOff,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import type { Conversation } from '@shared/types'
import type { ChatProject } from '@shared/chatProjects'
import { api, cn, formatRelative } from '@/lib/utils'
import { useApp } from '@/store/app'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tip
} from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { refreshProjects } from '../ProjectSettings'
import { errText } from '../useChat'

export function ConversationRow({
  conversation: c,
  projects,
  createProject,
  compact = false
}: {
  conversation: Conversation
  projects: ChatProject[]
  createProject: (done: (project: ChatProject) => void) => void
  compact?: boolean
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const active = useApp((s) => s.conversationId === c.id)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(c.title)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!renaming) return
    // 等菜单关闭并恢复焦点后，再将焦点交给行内输入框。
    const timer = setTimeout(() => input.current?.select(), 0)
    return () => clearTimeout(timer)
  }, [renaming])
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (error) {
      toast.error(errText(error))
    }
  }
  const update = async (patch: { title?: string; pinned?: boolean; projectId?: string | null }): Promise<void> => {
    await api.chat.update(c.id, patch)
    refreshProjects(qc)
  }
  const move = async (project: ChatProject | null): Promise<void> => {
    await update({ projectId: project?.id ?? null })
    if (project?.memory === 'project') toast(t('projects.moveMemoryNotice'))
  }
  const rename = (): void => {
    setTitle(c.title)
    setRenaming(true)
  }
  const saveTitle = async (): Promise<void> => {
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      await update({ title: title.trim() })
      setRenaming(false)
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setSaving(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (
      !(await confirm({
        title: t('chat.deleteTitle', { title: c.title || t('common.untitled') }),
        description: t('chat.deleteDesc'),
        confirmText: t('common.delete'),
        danger: true
      }))
    )
      return
    await api.chat.remove(c.id)
    if (useApp.getState().conversationId === c.id) useApp.getState().openConversation(null)
    refreshProjects(qc)
  }
  return (
    <div
      className={cn(
        'group flex min-w-0 items-center gap-1 rounded-lg transition-colors',
        active ? 'bg-surface shadow-card' : 'hover:bg-surface-hover',
        compact && 'ml-5'
      )}
      data-conversation-id={c.id}
    >
      {renaming ? (
        <form
          className="min-w-0 flex-1 px-2 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            void saveTitle()
          }}
        >
          <input
            ref={input}
            value={title}
            maxLength={200}
            disabled={saving}
            aria-label={t('projects.renameConversation')}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(false)
              }
            }}
            className="h-7 w-full rounded border border-accent bg-surface px-2 text-sm text-fg outline-none"
          />
        </form>
      ) : (
        <button
          type="button"
          data-sidebar-row
          onClick={() => useApp.getState().openConversation(c.id)}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault()
              rename()
            }
          }}
          aria-current={active ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {c.pinned ? (
            <Pin className="mt-0.5 size-3.5 shrink-0 text-accent" />
          ) : (
            <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-subtle" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-fg">{c.title || t('common.untitled')}</span>
            <span className="mt-0.5 block text-2xs text-subtle">{formatRelative(c.lastMessageAt ?? c.createdAt, i18n.language)}</span>
          </span>
        </button>
      )}
      {c.kind === 'workspace' && (
        <Tip label={t('projects.workspace')}>
          <span aria-label={t('projects.workspace')} className="shrink-0 text-subtle">
            <PanelsTopLeft className="size-3" />
          </span>
        </Tip>
      )}
      {!renaming && (
        <Menu>
          <Tip label={t('projects.conversationMenu')}>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={t('projects.conversationMenu')}
                className="mr-1.5 rounded p-1 text-subtle opacity-0 outline-none group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </MenuTrigger>
          </Tip>
          <MenuContent>
            <MenuItem onSelect={rename}>
              <Pencil />
              {t('common.rename')}
            </MenuItem>
            <MenuItem onSelect={() => void run(() => update({ pinned: !c.pinned }))}>
              {c.pinned ? <PinOff /> : <Pin />}
              {t(c.pinned ? 'projects.unpin' : 'projects.pin')}
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <FolderInput />
                {t('projects.moveTo')}
                <ChevronRight className="ml-auto" />
              </MenuSubTrigger>
              <MenuSubContent>
                {projects.map((project) => (
                  <MenuItem key={project.id} onSelect={() => void run(() => move(project))}>
                    <Check className={cn(c.projectId !== project.id && 'invisible')} />
                    {project.name}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem onSelect={() => createProject((project) => void run(() => move(project)))}>
                  <FolderPlus />
                  {t('projects.newProject')}
                </MenuItem>
                <MenuItem disabled={!c.projectId} onSelect={() => void run(() => move(null))}>
                  <FolderMinus />
                  {t('projects.unassign')}
                </MenuItem>
              </MenuSubContent>
            </MenuSub>
            <MenuSeparator />
            <MenuItem danger onSelect={() => void run(remove)}>
              <Trash2 />
              {t('common.delete')}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </div>
  )
}
