import { useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Folder, FolderPlus, MoreHorizontal, Plus, Search, SquarePen } from 'lucide-react'
import type { ChatProject } from '@shared/chatProjects'
import type { Conversation } from '@shared/types'
import { useChatProjects, useConversations } from '@/lib/queries'
import { cn, modKey } from '@/lib/utils'
import { tintFor } from '@/lib/tint'
import { useApp } from '@/store/app'
import { SidebarToggle } from '@/components/PageSidebar'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuTrigger, Tip } from '@/components/ui/primitives'
import { resetAttachmentDraft } from '../../attachments/useAttachments'
import { ChatSearch } from '../ChatSearch'
import { ConversationRow } from './ConversationRow'
import { ProjectMenuItems, useProjectActions } from './ProjectActions'

export function startProjectChat(id: string): void {
  resetAttachmentDraft('chat')
  useApp.getState().startProjectConversation(id)
}

function ProjectRow({
  project,
  current,
  actions,
  projects
}: {
  project: ChatProject
  current?: Conversation
  actions: ReturnType<typeof useProjectActions>
  projects: ChatProject[]
}) {
  const { t } = useTranslation()
  const active = useApp((s) => s.chatProjectId === project.id || s.chatNewProjectId === project.id) || !!current
  return (
    <div data-project-id={project.id}>
      <div
        className={cn(
          'group flex items-center gap-0.5 rounded-lg transition-colors',
          active ? 'bg-accent-soft/60' : 'hover:bg-surface-hover'
        )}
      >
        <button
          type="button"
          data-sidebar-row
          aria-current={active ? 'page' : undefined}
          onClick={() => useApp.getState().openChatProject(project.id)}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault()
              actions.rename(project)
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <span data-tint={tintFor(project.id, project.color)} className="tint grid size-5 shrink-0 place-items-center rounded-md">
            <Folder className="size-3.5 text-[var(--tint-ink)]" />
          </span>
          <span className="truncate text-sm text-fg">{project.name}</span>
        </button>
        <Tip label={t('projects.newChat')}>
          <button
            type="button"
            aria-label={t('projects.newChat')}
            onClick={() => startProjectChat(project.id)}
            className="rounded p-1 text-subtle opacity-0 outline-none group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
          >
            <Plus className="size-3.5" />
          </button>
        </Tip>
        <Menu>
          <Tip label={t('projects.projectMenu')}>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={t('projects.projectMenu')}
                className="mr-1.5 rounded p-1 text-subtle opacity-0 outline-none group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </MenuTrigger>
          </Tip>
          <MenuContent>
            <ProjectMenuItems project={project} actions={actions} />
          </MenuContent>
        </Menu>
      </div>
      {current && <ConversationRow compact conversation={current} projects={projects} createProject={actions.create} />}
    </div>
  )
}

export function ChatSidebar() {
  const { t } = useTranslation()
  const conversationId = useApp((s) => s.conversationId)
  const { data: list = [] } = useConversations()
  const { data: projects = [], isError } = useChatProjects()
  const actions = useProjectActions()
  const [collapsed, setCollapsed] = useState(false)
  const [search, setSearch] = useState(false)
  const conversations = list.filter((c) => c.kind === 'chat' || c.kind === 'workspace')
  const current = conversations.find((c) => c.id === conversationId)
  const pinned = conversations.filter((c) => c.pinned)
  const pinnedProjects = projects.filter((p) => p.pinned)
  const recent = conversations.filter((c) => !c.projectId && !c.pinned)
  const row = (project: ChatProject) => (
    <ProjectRow
      key={project.id}
      project={project}
      current={current?.projectId === project.id ? current : undefined}
      projects={projects}
      actions={actions}
    />
  )
  const navigateRows = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (!(e.target instanceof Element) || !e.target.closest('[data-sidebar-row]')) return
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-sidebar-row]')]
    const index = rows.findIndex((el) => el === document.activeElement)
    if (index < 0) return
    e.preventDefault()
    rows[(index + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
  }
  return (
    <aside className="flex h-full w-full flex-col" onKeyDown={navigateRows}>
      <div className="drag flex h-[52px] shrink-0 items-end justify-between px-4 pb-1.5">
        <h2 className="font-serif text-lg font-semibold tracking-wide text-fg">{t('chat.title')}</h2>
        <div className="no-drag flex items-center gap-0.5">
          <Tip label={t('projects.search')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('projects.search')} onClick={() => setSearch(true)}>
              <Search />
            </Button>
          </Tip>
          <SidebarToggle />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-4">
        <button
          type="button"
          data-sidebar-row
          aria-label={t('chat.new')}
          onClick={() => {
            resetAttachmentDraft('chat')
            useApp.getState().openConversation(null)
          }}
          className="mb-4 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-fg outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <SquarePen className="size-4 text-muted" />
          <span>{t('chat.new')}</span>
          <span className="ml-auto text-2xs text-subtle">{modKey}N</span>
        </button>
        {(pinnedProjects.length > 0 || pinned.length > 0) && (
          <section className="mb-4" aria-label={t('projects.pinned')}>
            <h3 className="px-3 py-1.5 text-2xs font-medium text-subtle">{t('projects.pinned')}</h3>
            <div className="space-y-0.5">
              {pinnedProjects.map(row)}
              {pinned.map((c) => (
                <ConversationRow key={c.id} conversation={c} projects={projects} createProject={actions.create} />
              ))}
            </div>
          </section>
        )}
        <section className="mb-4" aria-label={t('projects.title')}>
          <div className="flex items-center justify-between px-2 py-1">
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
              className="flex items-center gap-1.5 rounded px-1 py-1 text-2xs font-medium text-subtle hover:text-fg"
            >
              <ChevronDown className={cn('size-3 transition-transform', collapsed && '-rotate-90')} />
              {t('projects.title')}
            </button>
            <Tip label={t('projects.create')}>
              <Button variant="ghost" size="icon-sm" aria-label={t('projects.create')} onClick={() => actions.create()}>
                <FolderPlus className="size-3.5" />
              </Button>
            </Tip>
          </div>
          {!collapsed && (
            <div className="space-y-0.5">
              {projects.filter((p) => !p.pinned).map(row)}
              {projects.length === 0 && (
                <p className="px-3 py-2 text-xs text-subtle">{t(isError ? 'projects.loadFailed' : 'projects.noProjects')}</p>
              )}
            </div>
          )}
        </section>
        <section aria-label={t('projects.recent')}>
          <h3 className="px-3 py-1.5 text-2xs font-medium text-subtle">{t('projects.recent')}</h3>
          <div className="space-y-0.5">
            {recent.map((c) => (
              <ConversationRow key={c.id} conversation={c} projects={projects} createProject={actions.create} />
            ))}
            {recent.length === 0 && <p className="px-3 py-6 text-center text-xs text-subtle">{t('chat.noConversations')}</p>}
          </div>
        </section>
      </div>
      {actions.dialogs}
      {search && <ChatSearch close={() => setSearch(false)} />}
    </aside>
  )
}
