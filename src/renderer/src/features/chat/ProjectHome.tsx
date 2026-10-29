import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { FileUp, Folder, MoreHorizontal, Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import type { Conversation } from '@shared/types'
import type { ChatScope } from '@shared/schemas'
import { packetFromWorkspace } from '@shared/context'
import { useChatProjects, useProjectConversations } from '@/lib/queries'
import { tintFor } from '@/lib/tint'
import { cn, formatRelative } from '@/lib/utils'
import { getWorkspaceContext, useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '@/components/ui/primitives'
import { useAttachments } from '../attachments/useAttachments'
import { AttachmentDropZone } from '../attachments/AttachmentInput'
import { attachmentContext } from '../attachments/context'
import { EffortPicker } from '../ai/EffortPicker'
import { ModelPicker } from '../ai/ModelPicker'
import { WebModePicker, useWebMode } from '../retrieval/WebModePicker'
import { Composer } from './Composer'
import { ScopePicker } from './ScopePicker'
import { ProjectSources } from './ProjectSources'
import { useAddProjectSources } from './AddProjectSources'
import { errText, sendChat } from './useChat'
import { useChatModelChoice } from './modelChoice'
import { ConversationRow } from './sidebar/ConversationRow'
import { ProjectMenuItems, useProjectActions } from './sidebar/ProjectActions'

export function ProjectHome({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: projects = [], isPending: loadingProjects } = useChatProjects()
  const project = projects.find((p) => p.id === id)
  const { data: conversations = [], isPending, isError, refetch } = useProjectConversations(id)
  const actions = useProjectActions()
  const [tab, setTab] = useState<'conversations' | 'sources'>('conversations')
  const [scopeOverride, setScope] = useState<ChatScope | null>(null)
  const scope = scopeOverride ?? { type: project?.libraryScope === 'none' ? 'none' : 'all' }
  const { choice, setChoice, effort, setEffort, provider, rememberConversation } = useChatModelChoice(null, id)
  const { web, setWeb } = useWebMode(null, undefined)
  const attachments = useAttachments({ kind: 'chat', conversationId: null })
  const sourceAdder = useAddProjectSources(id)
  const send = async (text: string): Promise<boolean> => {
    if (!choice.providerId || !choice.model) {
      toast.error(t('chat.needModel'))
      return false
    }
    const attachmentIds = attachments.ids()
    try {
      const turn = await sendChat({
        conversationId: null,
        projectId: id,
        text,
        providerId: choice.providerId,
        model: choice.model,
        effort,
        web,
        ...(scopeOverride ? { scope: scopeOverride } : {}),
        attachments: attachmentIds,
        context: await attachmentContext(packetFromWorkspace(getWorkspaceContext()), null, attachmentIds)
      })
      rememberConversation(turn.conversation.id)
      attachments.clear(attachmentIds)
      qc.setQueryData(['messages', turn.conversation.id], [turn.userMessage, turn.assistant])
      qc.setQueryData<Conversation[]>(['conversations'], (items = []) => [
        turn.conversation,
        ...items.filter((item) => item.id !== turn.conversation.id)
      ])
      void qc.invalidateQueries({ queryKey: ['projectConversations', id] })
      void qc.invalidateQueries({ queryKey: ['conversations'] })
      const app = useApp.getState()
      // A slow send must not take the user away from the page they opened while waiting.
      if (app.view === 'chat' && app.chatProjectId === id) app.openConversation(turn.conversation.id)
      return true
    } catch (error) {
      toast.error(errText(error))
      return false
    }
  }
  const pickProjectSource = (): void => {
    void sourceAdder.pick().then((added) => {
      if (added) setTab('sources')
    })
  }
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
          <AttachmentDropZone controller={attachments}>
            <Composer
              busy={false}
              disabled={sourceAdder.adding}
              attachments={attachments}
              provider={provider}
              newConversation
              placeholder={t('projects.newChatIn', { name: project.name })}
              onSend={send}
              onStop={() => {}}
              tools={
                <>
                  <ModelPicker compact value={choice} onChange={setChoice} />
                  {provider && <EffortPicker compact provider={provider} model={choice.model} value={effort} onChange={setEffort} />}
                  <ScopePicker value={scope} onChange={setScope} />
                  <WebModePicker value={web} onChange={setWeb} />
                </>
              }
              attachmentButton={
                <Menu>
                  <Tip label={t('attach.add')}>
                    <MenuTrigger asChild>
                      <Button type="button" size="icon-sm" variant="ghost" disabled={sourceAdder.adding} aria-label={t('attach.add')}>
                        <Paperclip />
                      </Button>
                    </MenuTrigger>
                  </Tip>
                  <MenuContent align="start">
                    <MenuItem onSelect={() => void attachments.pick().catch((error) => toast.error(errText(error)))}>
                      <Paperclip />
                      {t('projects.attachmentThisChat')}
                    </MenuItem>
                    <MenuItem onSelect={pickProjectSource}>
                      <FileUp />
                      {t('projects.attachmentProject')}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              }
            />
          </AttachmentDropZone>
          {sourceAdder.adding && (
            <p role="status" className="mt-2 text-xs text-muted">
              {t('projects.addingSources')}
            </p>
          )}
          <div role="tablist" aria-label={t('projects.homeSections')} className="mt-8 flex gap-5 border-b border-border">
            {(['conversations', 'sources'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`project-${value}-tab`}
                aria-controls={`project-${value}-panel`}
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  'border-b-2 px-1 pb-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50',
                  tab === value ? 'border-accent text-fg' : 'border-transparent text-subtle hover:text-fg'
                )}
              >
                {t(value === 'conversations' ? 'projects.conversations' : 'projects.sources')}
              </button>
            ))}
          </div>
          {tab === 'sources' ? (
            <div role="tabpanel" id="project-sources-panel" aria-labelledby="project-sources-tab">
              <ProjectSources projectId={id} />
            </div>
          ) : (
            <div role="tabpanel" id="project-conversations-panel" aria-labelledby="project-conversations-tab">
              {isPending || isError || conversations.length === 0 ? (
                <div className="py-10 text-center text-xs text-subtle">
                  <p>{t(isPending ? 'projects.loading' : isError ? 'projects.loadFailed' : 'projects.noConversations')}</p>
                  {isError && (
                    <Button className="mt-3" size="sm" variant="ghost" onClick={() => void refetch()}>
                      {t('projects.retry')}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="mt-2 space-y-1">
                  {conversations.map((conversation) => (
                    <div key={conversation.id} className="rounded-xl border-b border-border/50 pb-2">
                      <ConversationRow conversation={conversation} projects={projects} createProject={actions.create} />
                      {conversation.summary && (
                        <button onClick={() => useApp.getState().openConversation(conversation.id)} className="block w-full px-9 text-left">
                          <p className="line-clamp-2 text-xs leading-relaxed text-muted">{conversation.summary}</p>
                          <p className="mt-1 text-2xs text-subtle">{formatRelative(conversation.lastMessageAt, i18n.language)}</p>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {actions.dialogs}
    </section>
  )
}
