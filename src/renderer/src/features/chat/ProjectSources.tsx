import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, FileText, FolderOpen, LoaderCircle, MoreHorizontal, NotebookText, Plus, RotateCw, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatProjectSource } from '@shared/chatProjects'
import type { SourceKind } from '@shared/types'
import { useProjectSources, useSettings } from '@/lib/queries'
import { api, cn, formatRelative } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { ArchiveAttachmentsDialog } from '../attachments/ConversationAttachments'
import { KIND_ICON } from '../library/LibraryView'
import { readinessText, ReadinessLabel } from '../library/ReadinessNotice'
import { AddProjectSources, ProjectSourceDropZone, useAddProjectSources } from './AddProjectSources'
import { errText } from './useChat'

type SourceFilter = 'all' | 'file' | 'library' | 'text' | 'url'
type SourceSort = 'newest' | 'oldest' | 'name'
const originFilter = { upload: 'file', library: 'library', text: 'text', url: 'url' } as const

export function ProjectSources({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: sources = [], isPending, isError, refetch } = useProjectSources(projectId)
  const { data: settings } = useSettings()
  const adder = useAddProjectSources(projectId)
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [sort, setSort] = useState<SourceSort>('newest')
  const [archive, setArchive] = useState<ChatProjectSource | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [reprocessing, setReprocessing] = useState<string | null>(null)
  const selected = sources
    .filter((item) => filter === 'all' || originFilter[item.origin] === filter)
    .sort((a, b) =>
      sort === 'name'
        ? a.title.localeCompare(b.title, i18n.language) || a.itemId.localeCompare(b.itemId)
        : (a.createdAt - b.createdAt) * (sort === 'oldest' ? 1 : -1) || a.itemId.localeCompare(b.itemId)
    )
  const refresh = (): void => {
    for (const key of ['projectSources', 'sources', 'attachment-space', 'attachment-count']) void qc.invalidateQueries({ queryKey: [key] })
  }
  const open = (item: ChatProjectSource): void => {
    if (!item.available) return
    if (item.itemType === 'note') useApp.getState().openNote(item.itemId)
    else useApp.getState().openSource(item.itemId)
  }
  const reprocess = async (item: ChatProjectSource): Promise<void> => {
    setReprocessing(item.itemId)
    try {
      await api.chatProjects.reprocessSource(projectId, item.itemId)
      refresh()
      toast.success(t('projects.reprocessingSource'))
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setReprocessing(null)
    }
  }
  const remove = async (item: ChatProjectSource): Promise<void> => {
    if (
      !(await confirm({
        title: t('projects.removeSourceTitle', { name: item.title }),
        description: t('projects.removeSourceDesc'),
        confirmText: t('projects.removeSource')
      }))
    )
      return
    setRemoving(`${item.itemType}:${item.itemId}`)
    try {
      await api.chatProjects.removeSource(projectId, item.itemType, item.itemId)
      refresh()
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setRemoving(null)
    }
  }
  return (
    <>
      {settings?.ai.recognition?.mode === 'cloud' && (
        <p className="mt-4 text-xs leading-relaxed text-muted" data-testid="project-ocr-cloud-notice">
          {t('projects.cloudRecognitionNotice')}
        </p>
      )}
      <ProjectSourceDropZone busy={adder.adding} addFiles={adder.addFiles} className="mt-4 min-h-64">
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <span>{t('projects.sourceFilter')}</span>
            <select
              aria-label={t('projects.sourceFilter')}
              value={filter}
              onChange={(event) => setFilter(event.target.value as SourceFilter)}
              className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-fg outline-none focus:border-accent"
            >
              {(['all', 'file', 'library', 'text', 'url'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`projects.sourceTypes.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <span>{t('projects.sourceSort')}</span>
            <select
              aria-label={t('projects.sourceSort')}
              value={sort}
              onChange={(event) => setSort(event.target.value as SourceSort)}
              className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-fg outline-none focus:border-accent"
            >
              {(['newest', 'oldest', 'name'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`projects.sourceSorts.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="outline" disabled={adder.adding} onClick={() => setAdding(true)}>
            <Plus />
            {t('projects.addSources')}
          </Button>
        </div>
        {adder.adding && (
          <p role="status" className="mb-3 flex items-center gap-2 text-xs text-muted">
            <LoaderCircle className="size-3.5 animate-spin" />
            {t('projects.addingSources')}
          </p>
        )}
        {isPending || isError ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-xs text-muted">
            <p>{t(isPending ? 'projects.loading' : 'projects.loadFailed')}</p>
            {isError && (
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => void refetch()}>
                {t('projects.retry')}
              </Button>
            )}
          </div>
        ) : !sources.length ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border px-8 py-10 text-center">
            <FolderOpen className="size-9 text-subtle" />
            <h3 className="mt-4 font-serif text-md font-semibold text-fg">{t('projects.sourcesEmptyTitle')}</h3>
            <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">{t('projects.sourcesEmptyDesc')}</p>
            <Button className="mt-5" variant="primary" disabled={adder.adding} onClick={() => setAdding(true)}>
              <Plus />
              {t('projects.addSources')}
            </Button>
          </div>
        ) : !selected.length ? (
          <p className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-xs text-muted">
            {t('projects.noMatchingSources')}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="project-sources-list">
            {selected.map((item) => (
              <li
                key={`${item.itemType}:${item.itemId}`}
                data-project-source-id={item.itemId}
                data-source-origin={item.origin}
                className="group flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3"
              >
                <span className="mt-0.5 shrink-0 text-subtle [&_svg]:size-5">
                  {item.itemType === 'note' ? <NotebookText /> : (KIND_ICON[item.kind as SourceKind] ?? <FileText />)}
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => open(item)}
                    disabled={!item.available}
                    className="block max-w-full truncate text-left text-sm font-medium text-fg hover:text-accent disabled:text-subtle"
                    title={item.title}
                  >
                    {item.title || t('common.untitled')}
                  </button>
                  <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-subtle">
                    <span>
                      {item.itemType === 'note'
                        ? t('nav.notes')
                        : item.kind in KIND_ICON
                          ? t(`library.kinds.${item.kind}`)
                          : t('projects.sourceTypes.file')}
                    </span>
                    <span>·</span>
                    <span>{t(`projects.sourceOrigins.${item.origin}`)}</span>
                    <span>·</span>
                    <time dateTime={new Date(item.createdAt).toISOString()}>{formatRelative(item.createdAt, i18n.language)}</time>
                    {item.space === 'library' && item.origin !== 'library' && <span className="text-accent">{t('attach.archived')}</span>}
                  </p>
                  {!item.available ? (
                    <p role="status" className="mt-2 text-2xs text-danger">
                      {t('projects.sourceUnavailable')}
                    </p>
                  ) : item.readiness && item.readiness.state !== 'ready' ? (
                    <div aria-label={readinessText(item.readiness, t)} role="status">
                      <ReadinessLabel sourceId={item.itemId} readiness={item.readiness} projectId={projectId} />
                    </div>
                  ) : (
                    <p role="status" className="mt-2 text-2xs text-accent">
                      {t('projects.sourceReady')}
                    </p>
                  )}
                </div>
                <Menu>
                  <Tip label={t('projects.sourceMenu')}>
                    <MenuTrigger asChild>
                      <button
                        type="button"
                        disabled={removing === `${item.itemType}:${item.itemId}`}
                        aria-label={t('projects.sourceMenu')}
                        className={cn(
                          'shrink-0 rounded p-1 text-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50',
                          removing === `${item.itemType}:${item.itemId}` && 'opacity-50'
                        )}
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    </MenuTrigger>
                  </Tip>
                  <MenuContent>
                    {item.itemType === 'source' && item.kind === 'pdf' && (
                      <MenuItem disabled={!item.available || reprocessing === item.itemId} onSelect={() => void reprocess(item)}>
                        <RotateCw />
                        {t('projects.reprocessSource')}
                      </MenuItem>
                    )}
                    <MenuItem disabled={!item.available} onSelect={() => open(item)}>
                      <FolderOpen />
                      {t('projects.openSource')}
                    </MenuItem>
                    {item.itemType === 'source' && item.origin !== 'library' && item.space === 'attachment' && (
                      <MenuItem disabled={!item.available} onSelect={() => setArchive(item)}>
                        <Archive />
                        {t('attach.archive')}
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem danger onSelect={() => void remove(item)}>
                      <Unlink />
                      {t('projects.removeSource')}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </li>
            ))}
          </ul>
        )}
      </ProjectSourceDropZone>
      {adding && <AddProjectSources projectId={projectId} existing={sources} close={() => setAdding(false)} />}
      {archive && (
        <ArchiveAttachmentsDialog
          ids={[archive.itemId]}
          archive={(categoryId) => api.chatProjects.archiveSource(projectId, archive.itemId, categoryId)}
          onClose={() => setArchive(null)}
          onArchived={() => {
            refresh()
            toast.success(t('projects.sourceArchived'))
          }}
        />
      )}
    </>
  )
}
