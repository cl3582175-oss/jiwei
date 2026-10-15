import { useEffect, useRef, useState } from 'react'
import { Dialog as D } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatProject } from '@shared/chatProjects'
import { createAutosave } from '@/lib/autosave'
import { TINTS, tintFor } from '@/lib/tint'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Input, Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { errText } from './useChat'

export function refreshProjects(qc: ReturnType<typeof useQueryClient>): void {
  for (const key of ['chatProjects', 'projectConversations', 'conversations', 'memories']) void qc.invalidateQueries({ queryKey: [key] })
}

type Fields = Pick<ChatProject, 'name' | 'color' | 'instructions' | 'libraryScope'>
const dialogClass =
  'fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-float outline-none'
const selectClass = 'mt-1.5 h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent'

function NameFields({ value, change }: { value: Fields; change: (patch: Partial<Fields>) => void }) {
  const { t } = useTranslation()
  return (
    <>
      <label className="block text-xs font-medium text-fg">
        {t('projects.name')}
        <Input
          autoFocus
          maxLength={60}
          className="mt-1.5"
          value={value.name}
          aria-label={t('projects.name')}
          onChange={(e) => change({ name: e.target.value })}
        />
      </label>
      <fieldset className="mt-4">
        <legend className="text-xs font-medium text-fg">{t('projects.color')}</legend>
        <div className="mt-2 flex gap-2">
          {TINTS.map((color) => (
            <Tip key={color} label={t(`tints.${color}`)} side="top">
              <button
                type="button"
                data-tint={color}
                aria-label={t(`tints.${color}`)}
                aria-pressed={tintFor('project', value.color) === color}
                onClick={() => change({ color })}
                className={cn(
                  'tint grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-surface',
                  tintFor('project', value.color) === color && 'ring-2 ring-[var(--tint-ink)]'
                )}
              >
                {tintFor('project', value.color) === color ? (
                  <Check className="size-3.5 text-[var(--tint-ink)]" />
                ) : (
                  <span className="tint-dot size-2 rounded-full" />
                )}
              </button>
            </Tip>
          ))}
        </div>
      </fieldset>
    </>
  )
}

function MemoryField({
  value,
  existing,
  disabled,
  change
}: {
  value: ChatProject['memory']
  existing?: boolean
  disabled?: boolean
  change: (mode: ChatProject['memory']) => void
}) {
  const { t } = useTranslation()
  return (
    <label className="block text-xs font-medium text-fg">
      {t('projects.memory')}
      <select
        className={selectClass}
        value={value}
        disabled={disabled}
        aria-label={t('projects.memory')}
        onChange={(e) => change(e.target.value as ChatProject['memory'])}
      >
        <option value="default">{t('projects.memoryDefault')}</option>
        <option value="project" disabled={existing && value === 'default'}>
          {t('projects.memoryProject')}
        </option>
      </select>
      <span className="mt-1.5 block text-xs font-normal leading-relaxed text-muted">
        {t(value === 'default' ? 'projects.memoryDefaultDesc' : 'projects.memoryProjectDesc')}
      </span>
      {existing && value === 'default' && (
        <span className="mt-1 block text-xs font-normal leading-relaxed text-subtle">{t('projects.memoryLocked')}</span>
      )}
    </label>
  )
}

function Modal({ title, close, busy, children }: { title: string; close: () => void; busy: boolean; children: React.ReactNode }) {
  const { t } = useTranslation()
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (!busy) close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, close])
  return (
    <D.Root open onOpenChange={(open) => !open && !busy && close()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <D.Content
          className={dialogClass}
          data-testid="project-settings"
          onKeyDownCapture={(event) => {
            // A just-opened menu dialog can receive Escape before Radix registers its dismiss layer.
            if (event.key === 'Escape' && !busy) {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
        >
          <D.Title className="pr-8 font-serif text-lg font-semibold text-fg">{title}</D.Title>
          <D.Description className="sr-only">{title}</D.Description>
          <Tip label={t('projects.close')} side="left">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-4 right-4"
              aria-label={t('projects.close')}
              disabled={busy}
              onClick={close}
            >
              <X />
            </Button>
          </Tip>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

function CreateProject({ close, created }: { close: () => void; created: (project: ChatProject) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [value, setValue] = useState<Fields>({ name: '', color: 'bamboo', instructions: '', libraryScope: 'all' })
  const [memory, setMemory] = useState<ChatProject['memory']>('default')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (!value.name.trim() || busy) return
    setBusy(true)
    try {
      const project = await api.chatProjects.create({ ...value, name: value.name.trim(), memory })
      refreshProjects(qc)
      created(project)
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('projects.create')} close={close} busy={busy}>
      <form
        className="mt-5 space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div>
          <NameFields value={value} change={(patch) => setValue((current) => ({ ...current, ...patch }))} />
        </div>
        <MemoryField value={memory} change={setMemory} disabled={busy} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !value.name.trim()}>
            {t('projects.create')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function EditProject({ project, close, remove }: { project: ChatProject; close: () => void; remove: (project: ChatProject) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [value, setValue] = useState<Fields>({
    name: project.name,
    color: project.color,
    instructions: project.instructions,
    libraryScope: project.libraryScope
  })
  const [memory, setMemory] = useState(project.memory)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'saving' | 'saved'>('saved')
  const [failed, setFailed] = useState(false)
  const draft = useRef(value)
  const [save] = useState(() =>
    createAutosave(
      value,
      async (fields: Fields) => {
        if (!fields.name.trim()) throw new Error(t('projects.nameRequired'))
        await api.chatProjects.update(project.id, { ...fields, name: fields.name.trim() })
        setFailed(false)
        refreshProjects(qc)
      },
      {
        onState: setStatus,
        onError: (error) => {
          setFailed(true)
          toast.error(errText(error))
        }
      }
    )
  )
  const change = (patch: Partial<Fields>): void => {
    draft.current = { ...draft.current, ...patch }
    setValue(draft.current)
    setFailed(false)
    save.change(draft.current)
  }
  useEffect(() => {
    const flush = (): void => {
      void save.flush().catch(() => {})
    }
    window.addEventListener('jiwei:flush-settings', flush)
    return () => {
      window.removeEventListener('jiwei:flush-settings', flush)
      flush()
    }
  }, [save])
  const flushThen = async (next: () => void): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await save.flush()
      next()
    } catch {
      /* Autosave reports and keeps the dialog open for recovery. */
    } finally {
      setBusy(false)
    }
  }
  const changeMemory = async (mode: ChatProject['memory']): Promise<void> => {
    if (mode === memory || busy || mode === 'project') return
    setBusy(true)
    try {
      await save.flush()
      const latest = await api.chatProjects.get(project.id)
      if (!latest) throw new Error(t('projects.unavailable'))
      if (
        !(await confirm({
          title: t('projects.promoteTitle'),
          description: t('projects.promoteDesc', { count: latest.memoryCount }),
          confirmText: t('projects.promote')
        }))
      )
        return
      await api.chatProjects.update(project.id, { memory: 'default', promoteMemories: true })
      setMemory('default')
      refreshProjects(qc)
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('projects.settings')} close={() => void flushThen(close)} busy={busy}>
      <div
        className="mt-5 space-y-5"
        onBlur={() => {
          void save.flush().catch(() => {})
        }}
      >
        <NameFields value={value} change={change} />
        <label className="block text-xs font-medium text-fg">
          {t('projects.instructions')}
          <textarea
            value={value.instructions}
            rows={4}
            maxLength={4000}
            aria-label={t('projects.instructions')}
            placeholder={t('projects.instructionsPh')}
            onChange={(e) => change({ instructions: e.target.value })}
            className="mt-1.5 block w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm font-normal leading-relaxed outline-none focus:border-accent"
          />
          <span className="mt-1 block text-right text-2xs font-normal text-subtle">{value.instructions.length} / 4000</span>
        </label>
        <MemoryField value={memory} existing disabled={busy} change={(mode) => void changeMemory(mode)} />
        <label className="block text-xs font-medium text-fg">
          {t('projects.libraryScope')}
          <select
            className={selectClass}
            value={value.libraryScope}
            aria-label={t('projects.libraryScope')}
            onChange={(e) => change({ libraryScope: e.target.value as Fields['libraryScope'] })}
          >
            <option value="all">{t('chat.scope.all')}</option>
            <option value="none">{t('chat.scope.none')}</option>
          </select>
          <span className="mt-1.5 block text-xs font-normal leading-relaxed text-muted">{t('projects.libraryScopeDesc')}</span>
        </label>
        <div className="flex items-center justify-between border-t border-border pt-4">
          <Button
            variant="ghost"
            className="text-danger hover:text-danger"
            disabled={busy}
            onClick={() => void flushThen(() => remove({ ...project, ...draft.current, memory }))}
          >
            <Trash2 />
            {t('projects.delete')}
          </Button>
          <span role="status" className={cn('text-2xs', failed ? 'text-danger' : 'text-subtle')}>
            {t(failed ? 'projects.saveFailed' : status === 'saving' ? 'memory.saving' : 'memory.saved')}
          </span>
        </div>
      </div>
    </Modal>
  )
}

export function ProjectSettings({
  project,
  close,
  created,
  remove
}: {
  project: ChatProject | null
  close: () => void
  created: (project: ChatProject) => void
  remove: (project: ChatProject) => void
}) {
  return project ? (
    <EditProject key={project.id} project={project} close={close} remove={remove} />
  ) : (
    <CreateProject close={close} created={created} />
  )
}

export function DeleteProjectDialog({ project, close }: { project: ChatProject; close: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'recent' | 'delete'>('recent')
  const [busy, setBusy] = useState(false)
  const { data: current = project } = useQuery({
    queryKey: ['chatProject', project.id],
    queryFn: () => api.chatProjects.get(project.id),
    initialData: project
  })
  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const conversations = mode === 'delete' ? await api.chatProjects.conversations(project.id) : []
      await api.chatProjects.remove(project.id, mode)
      const app = useApp.getState()
      if (app.chatProjectId === project.id || app.chatNewProjectId === project.id || conversations.some((c) => c.id === app.conversationId))
        app.openConversation(null)
      refreshProjects(qc)
      close()
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('projects.deleteTitle', { name: current?.name ?? project.name })} close={close} busy={busy}>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        {t('projects.deleteDesc', { count: current?.memoryCount ?? project.memoryCount })}
      </p>
      <fieldset className="mt-4 space-y-2">
        {(['recent', 'delete'] as const).map((option) => (
          <label
            key={option}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-xl border p-3',
              option === mode ? 'border-accent bg-accent-soft/30' : 'border-border'
            )}
          >
            <input
              type="radio"
              name="project-delete-mode"
              value={option}
              checked={mode === option}
              disabled={busy}
              onChange={() => setMode(option)}
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            <span className="text-sm text-fg">
              {t(option === 'recent' ? 'projects.keepConversations' : 'projects.deleteConversations')}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={close}>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void remove()}>
          {t('projects.delete')}
        </Button>
      </div>
    </Modal>
  )
}
