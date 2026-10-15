import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Download, FolderOpen, Pencil, Pin, PinOff, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatProject } from '@shared/chatProjects'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { prompt } from '@/components/ui/confirm'
import { MenuItem, MenuSeparator } from '@/components/ui/primitives'
import { ProjectSettings, DeleteProjectDialog, refreshProjects } from '../ProjectSettings'
import { errText } from '../useChat'

export function useProjectActions() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<{ project: ChatProject | null; created?: (project: ChatProject) => void } | null>(null)
  const [deleting, setDeleting] = useState<ChatProject | null>(null)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (error) {
      toast.error(errText(error))
    }
  }
  const actions = {
    create: (created?: (project: ChatProject) => void): void => setEditing({ project: null, created }),
    settings: (project: ChatProject): void => setEditing({ project }),
    remove: (project: ChatProject): void => setDeleting(project),
    rename: (project: ChatProject): void => {
      void run(async () => {
        const name = await prompt({ title: t('projects.rename'), defaultValue: project.name, confirmText: t('common.save') })
        if (!name || name === project.name) return
        if (name.length > 60) {
          toast.error(t('projects.nameTooLong'))
          return
        }
        await api.chatProjects.update(project.id, { name })
        refreshProjects(qc)
      })
    },
    pin: (project: ChatProject): void => {
      void run(async () => {
        await api.chatProjects.update(project.id, { pinned: !project.pinned })
        refreshProjects(qc)
      })
    },
    export: (project: ChatProject): void => {
      void run(async () => {
        const path = await api.chatProjects.exportMarkdown(project.id)
        if (path) toast.success(t('projects.exported'))
      })
    }
  }
  const dialogs = (
    <>
      {editing && (
        <ProjectSettings
          project={editing.project}
          close={() => setEditing(null)}
          created={(project) => {
            const created = editing.created
            setEditing(null)
            if (created) created(project)
            else useApp.getState().openChatProject(project.id)
          }}
          remove={(project) => {
            setEditing(null)
            setDeleting(project)
          }}
        />
      )}
      {deleting && <DeleteProjectDialog project={deleting} close={() => setDeleting(null)} />}
    </>
  )
  return { ...actions, dialogs }
}

export function ProjectMenuItems({ project, actions }: { project: ChatProject; actions: ReturnType<typeof useProjectActions> }) {
  const { t } = useTranslation()
  return (
    <>
      <MenuItem onSelect={() => actions.rename(project)}>
        <Pencil />
        {t('common.rename')}
      </MenuItem>
      <MenuItem onSelect={() => actions.settings(project)}>
        <Settings2 />
        {t('projects.settings')}
      </MenuItem>
      <MenuItem onSelect={() => useApp.getState().openChatProject(project.id)}>
        <FolderOpen />
        {t('projects.home')}
      </MenuItem>
      <MenuItem onSelect={() => actions.pin(project)}>
        {project.pinned ? <PinOff /> : <Pin />}
        {t(project.pinned ? 'projects.unpin' : 'projects.pin')}
      </MenuItem>
      <MenuItem onSelect={() => actions.export(project)}>
        <Download />
        {t('projects.export')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger onSelect={() => actions.remove(project)}>
        <Trash2 />
        {t('projects.delete')}
      </MenuItem>
    </>
  )
}
