import { useTranslation } from 'react-i18next'
import { Folder, MoreHorizontal, Plus } from 'lucide-react'
import { useChatProjects, useProjectConversations } from '@/lib/queries'
import { tintFor } from '@/lib/tint'
import { formatRelative } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuTrigger, Tip } from '@/components/ui/primitives'
import { ConversationRow } from './sidebar/ConversationRow'
import { ProjectMenuItems, useProjectActions } from './sidebar/ProjectActions'
import { startProjectChat } from './sidebar/ChatSidebar'

/** P4 project home; project sources are added by the subsequent phase. */
export function ProjectHome({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const { data: projects = [], isPending: loadingProjects } = useChatProjects()
  const project = projects.find((p) => p.id === id)
  const { data: conversations = [], isPending, isError } = useProjectConversations(id)
  const actions = useProjectActions()
  if (!project)
    return (
      <div className="grid h-full place-items-center">
        <div className="text-center">
          <p className="text-sm text-muted">{t(loadingProjects ? 'projects.loading' : 'projects.unavailable')}</p>
          {!loadingProjects && (
            <Button className="mt-4" variant="outline" onClick={() => useApp.getState().openConversation(null)}>
              {t('chat.new')}
            </Button>
          )}
        </div>
      </div>
    )
  return (
    <section className="flex h-full flex-col" data-testid="project-home">
      <header className="drag flex h-[52px] shrink-0 items-center justify-between border-b border-border/70 pr-[calc(var(--tb-right)+12px)] pl-6">
        <div className="flex min-w-0 items-center gap-2">
          <span data-tint={tintFor(project.id, project.color)} className="tint grid size-6 place-items-center rounded-lg">
            <Folder className="size-4 text-[var(--tint-ink)]" />
          </span>
          <h1 className="truncate font-serif text-lg font-semibold text-fg">{project.name}</h1>
        </div>
        <div className="no-drag">
          <Menu>
            <Tip label={t('projects.projectMenu')}>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('projects.projectMenu')}>
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
            </Tip>
            <MenuContent>
              <ProjectMenuItems project={project} actions={actions} />
            </MenuContent>
          </Menu>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto max-w-[760px]">
          {project.instructions && <p className="mb-5 whitespace-pre-wrap text-sm leading-relaxed text-muted">{project.instructions}</p>}
          <button
            className="paper flex w-full items-center gap-3 rounded-2xl px-5 py-5 text-left text-sm text-muted shadow-card transition-colors hover:text-fg"
            onClick={() => startProjectChat(id)}
          >
            <Plus className="size-4" />
            {t('projects.newChatIn', { name: project.name })}
          </button>
          <h2 className="mt-8 border-b border-border pb-3 text-sm font-medium text-fg">{t('projects.conversations')}</h2>
          {isPending || isError || conversations.length === 0 ? (
            <p className="py-10 text-center text-xs text-subtle">
              {t(isPending ? 'projects.loading' : isError ? 'projects.loadFailed' : 'projects.noConversations')}
            </p>
          ) : (
            <div className="mt-2 space-y-1">
              {conversations.map((c) => (
                <div key={c.id} className="rounded-xl border-b border-border/50 pb-2">
                  <ConversationRow conversation={c} projects={projects} createProject={actions.create} />
                  {c.summary && (
                    <button onClick={() => useApp.getState().openConversation(c.id)} className="block w-full px-9 text-left">
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted">{c.summary}</p>
                      <p className="mt-1 text-2xs text-subtle">{formatRelative(c.lastMessageAt, i18n.language)}</p>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {actions.dialogs}
    </section>
  )
}
