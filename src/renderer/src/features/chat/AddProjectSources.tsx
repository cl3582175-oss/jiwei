import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Dialog as D } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ClipboardPaste, FileUp, Globe, Library, LoaderCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatProjectSource, ProjectSourcesInput } from '@shared/chatProjects'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { ItemsDialog } from './ScopePicker'
import { errText } from './useChat'

export function useAddProjectSources(projectId: string) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const locked = useRef(false)
  const add = async (input: ProjectSourcesInput): Promise<boolean> => {
    if (locked.current) return false
    locked.current = true
    setAdding(true)
    try {
      const items = await api.chatProjects.addSources(projectId, input)
      // The native file picker returns an empty list when cancelled.
      if (input.origin === 'upload' && !items.length) return false
      for (const key of ['projectSources', 'attachment-space', 'attachment-count', 'sources'])
        void qc.invalidateQueries({ queryKey: [key] })
      return true
    } catch (error) {
      toast.error(errText(error))
      return false
    } finally {
      locked.current = false
      setAdding(false)
    }
  }
  const addFiles = async (files: File[]): Promise<boolean> => {
    if (!files.length) return false
    if (files.length > 50) {
      toast.error(t('projects.tooManySources', { count: 50 }))
      return false
    }
    try {
      const paths = files.map((file) => window.platform.pathForFile(file))
      if (paths.some((path) => !path)) {
        toast.error(t('projects.dropUnavailable'))
        return false
      }
      return add({ origin: 'upload', paths })
    } catch (error) {
      toast.error(errText(error))
      return false
    }
  }
  return { adding, add, addFiles, pick: () => add({ origin: 'upload' }) }
}

export function ProjectSourceDropZone({
  children,
  addFiles,
  busy,
  className
}: {
  children: ReactNode
  addFiles: (files: File[]) => Promise<unknown>
  busy?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const files = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files')
  return (
    <div
      data-testid="project-source-dropzone"
      className={cn('relative', className)}
      aria-busy={busy}
      onDragEnter={(event) => {
        if (files(event)) {
          event.preventDefault()
          event.stopPropagation()
          depth.current++
          setDragging(true)
        }
      }}
      onDragOver={(event) => {
        if (files(event)) {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
        }
      }}
      onDragLeave={(event) => {
        if (files(event)) {
          event.preventDefault()
          event.stopPropagation()
          depth.current = Math.max(0, depth.current - 1)
          if (!depth.current) setDragging(false)
        }
      }}
      onDrop={(event) => {
        if (files(event) || event.dataTransfer.files.length) {
          event.preventDefault()
          event.stopPropagation()
          depth.current = 0
          setDragging(false)
          if (!busy) void addFiles(Array.from(event.dataTransfer.files))
        }
      }}
    >
      {children}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/95 p-6 text-center text-sm font-medium text-accent">
          {t(busy ? 'projects.addingSources' : 'projects.dropSources')}
        </div>
      )}
    </div>
  )
}

export function AddProjectSources({ projectId, existing, close }: { projectId: string; existing: ChatProjectSource[]; close: () => void }) {
  const { t } = useTranslation()
  const adder = useAddProjectSources(projectId)
  const [mode, setMode] = useState<'choose' | 'library' | 'text' | 'url'>('choose')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const finish = async (input: ProjectSourcesInput): Promise<void> => {
    if (await adder.add(input)) close()
  }
  const submitUrl = (): void => {
    try {
      const parsed = new URL(url.trim())
      if (!['http:', 'https:'].includes(parsed.protocol)) throw Error()
      void finish({ origin: 'url', url: parsed.href })
    } catch {
      toast.error(t('projects.urlInvalid'))
    }
  }
  if (mode === 'library')
    return (
      <ItemsDialog
        open
        onOpenChange={(open) => !open && setMode('choose')}
        title={t('projects.libraryPicker')}
        description={t('projects.libraryPickerDesc')}
        confirmText={t('projects.addSources')}
        maxPerType={50}
        initial={{ notes: [], sources: [] }}
        onDone={async (selected) => {
          const notes = selected.notes.filter((id) => !existing.some((item) => item.itemType === 'note' && item.itemId === id))
          const sources = selected.sources.filter((id) => !existing.some((item) => item.itemType === 'source' && item.itemId === id))
          const added = (!notes.length && !sources.length) || (await adder.add({ origin: 'library', notes, sources }))
          if (added) close()
          return added
        }}
      />
    )
  return (
    <D.Root open onOpenChange={(open) => !open && !adder.adding && close()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <D.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(92vw,600px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-float outline-none"
          data-testid="add-project-sources"
        >
          <D.Title className="pr-8 font-serif text-lg font-semibold text-fg">
            {t(mode === 'text' ? 'projects.pasteText' : mode === 'url' ? 'projects.addUrl' : 'projects.addSources')}
          </D.Title>
          <D.Description className="mt-2 text-xs leading-relaxed text-muted">{t('projects.addSourcesDesc')}</D.Description>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="absolute top-4 right-4"
            disabled={adder.adding}
            aria-label={t('common.close')}
            onClick={close}
          >
            <X />
          </Button>

          {mode === 'choose' ? (
            <>
              <ProjectSourceDropZone
                busy={adder.adding}
                addFiles={async (files) => {
                  if (await adder.addFiles(files)) close()
                }}
                className="mt-5"
              >
                <button
                  type="button"
                  disabled={adder.adding}
                  onClick={() => void adder.pick().then((added) => added && close())}
                  className="flex min-h-40 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border px-6 py-7 text-center text-muted hover:border-accent hover:bg-accent-soft/20"
                >
                  <FileUp className="size-8 text-subtle" />
                  <span className="text-sm font-medium text-fg">{t('projects.dropFilesHere')}</span>
                  <span className="text-xs">{t('projects.uploadHint')}</span>
                </button>
              </ProjectSourceDropZone>
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    { mode: 'upload', icon: FileUp, label: 'projects.upload' },
                    { mode: 'library', icon: Library, label: 'projects.library' },
                    { mode: 'text', icon: ClipboardPaste, label: 'projects.pasteText' },
                    { mode: 'url', icon: Globe, label: 'projects.url' }
                  ] as const
                ).map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    disabled={adder.adding}
                    onClick={() => (option.mode === 'upload' ? void adder.pick().then((added) => added && close()) : setMode(option.mode))}
                    className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border border-border px-2 py-4 text-xs text-fg transition-colors hover:border-accent hover:bg-accent-soft/30 disabled:opacity-50"
                  >
                    <option.icon className="size-5 text-muted" />
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <form
              className="mt-5 space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (mode === 'text') void finish({ origin: 'text', title: title.trim(), text: text.trim() })
                else submitUrl()
              }}
            >
              <fieldset disabled={adder.adding} className="space-y-4">
                {mode === 'text' ? (
                  <>
                    <label className="block text-xs font-medium text-fg">
                      {t('projects.textTitle')}
                      <Input
                        autoFocus
                        required
                        maxLength={200}
                        aria-label={t('projects.textTitle')}
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        className="mt-1.5"
                      />
                    </label>
                    <label className="block text-xs font-medium text-fg">
                      {t('projects.textBody')}
                      <textarea
                        required
                        maxLength={1000000}
                        rows={8}
                        aria-label={t('projects.textBody')}
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        className="mt-1.5 block w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm font-normal leading-relaxed text-fg outline-none focus:border-accent"
                      />
                    </label>
                  </>
                ) : (
                  <label className="block text-xs font-medium text-fg">
                    {t('projects.url')}
                    <Input
                      autoFocus
                      required
                      type="url"
                      maxLength={4000}
                      aria-label={t('projects.url')}
                      placeholder="https://"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      className="mt-1.5"
                    />
                  </label>
                )}
                <div className="flex justify-between gap-2">
                  <Button type="button" variant="ghost" onClick={() => setMode('choose')}>
                    <ArrowLeft />
                    {t('projects.back')}
                  </Button>
                  <Button type="submit" variant="primary" disabled={mode === 'text' ? !title.trim() || !text.trim() : !url.trim()}>
                    {t('projects.addSources')}
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
          {adder.adding && (
            <p role="status" className="mt-4 flex items-center gap-2 text-xs text-muted">
              <LoaderCircle className="size-3.5 animate-spin" />
              {t('projects.addingSources')}
            </p>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
