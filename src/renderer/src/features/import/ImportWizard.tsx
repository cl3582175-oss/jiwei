import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog as D } from 'radix-ui'
import { FolderInput, Loader2, X } from 'lucide-react'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { ImportPreview } from './ImportPreview'
import type { ImportEntry, ImportIssue, ImportOptions, ImportPreview as Preview } from '@shared/importer'

function Issues({ issues }: { issues: ImportIssue[] }) {
  const { t } = useTranslation(),
    [limit, setLimit] = useState(50)
  return (
    <details className="rounded-lg border border-border p-3 text-sm">
      <summary className="cursor-pointer">
        {t('importer.issueTitle')} ({issues.length})
      </summary>
      <ul className="mt-2 space-y-1 text-xs text-muted">
        {issues.slice(0, limit).map((issue, i) => (
          <li key={i}>
            <span className="font-mono">{issue.path}</span>
            {issue.path && ' · '}
            {t(`importer.issues.${issue.code}`)}
            {issue.count && ` (${issue.count})`}
          </li>
        ))}
      </ul>
      {issues.length > limit && (
        <Button size="sm" variant="ghost" onClick={() => setLimit(limit + 50)}>
          {t('importer.more')}
        </Button>
      )}
      {!issues.length && <p>{t('importer.noIssues')}</p>}
    </details>
  )
}
function Tree({
  entries,
  selected,
  toggle,
  preview
}: {
  entries: ImportEntry[]
  selected: Set<string>
  toggle: (paths: string[], checked: boolean) => void
  preview: (path: string) => void
}) {
  const { t } = useTranslation(),
    [limit, setLimit] = useState(50)
  const render = (prefix: string): React.ReactNode => {
    const matching = entries.filter((e) => e.path.startsWith(prefix)),
      folders = [
        ...new Set(
          matching
            .map((e) => e.path.slice(prefix.length))
            .filter((p) => p.includes('/'))
            .map((p) => p.split('/')[0])
        )
      ]
    const direct = matching.filter((e) => !e.path.slice(prefix.length).includes('/'))
    return (
      <div className="space-y-1">
        {folders.map((folder) => {
          const path = `${prefix}${folder}/`,
            children = entries.filter((e) => e.path.startsWith(path)),
            paths = children.map((e) => e.path),
            count = paths.filter((p) => selected.has(p)).length
          return (
            <details key={path} open className="rounded border border-border px-2 py-1">
              <summary className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={t('importer.folderLabel', { name: path.slice(0, -1) })}
                  checked={count === paths.length}
                  ref={(input) => {
                    if (input) input.indeterminate = count > 0 && count < paths.length
                  }}
                  onChange={(e) => toggle(paths, e.target.checked)}
                />
                {folder}
                <span className="text-xs text-muted">
                  {count}/{paths.length}
                </span>
              </summary>
              <div className="mt-1 pl-3">{render(path)}</div>
            </details>
          )
        })}
        {direct.slice(0, limit).map((e) => (
          <div key={e.path} className="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-sm">
            <input
              type="checkbox"
              aria-label={e.path}
              checked={selected.has(e.path)}
              onChange={(event) => toggle([e.path], event.target.checked)}
            />
            <button
              className="min-w-0 flex-1 text-left hover:text-accent"
              aria-label={t('importer.preview', { title: e.title })}
              onClick={() => preview(e.path)}
            >
              <span className="block truncate">{e.title}</span>
              <span className="block truncate font-mono text-[11px] text-muted">{e.path}</span>
            </button>
            <span className="shrink-0 text-xs text-muted">{t(`importer.statuses.${e.status}`)}</span>
          </div>
        ))}
        {direct.length > limit && (
          <Button size="sm" variant="ghost" onClick={() => setLimit(limit + 50)}>
            {t('importer.more')}
          </Button>
        )}
      </div>
    )
  }
  return (
    <div data-testid="import-tree" className="max-h-72 overflow-y-auto rounded-lg border border-border p-2">
      {render('')}
    </div>
  )
}

export function ImportLibraryButton() {
  const { t } = useTranslation(),
    qc = useQueryClient()
  const [open, setOpen] = useState(false),
    [scanId, setScanId] = useState<string | null>(null),
    [runId, setRunId] = useState<string | null>(null),
    [step, setStep] = useState<'choose' | 'preview' | 'options' | 'run' | 'history'>('choose')
  const [selected, setSelected] = useState(new Set<string>()),
    [value, setValue] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [cueMessage, setCueMessage] = useState(false)
  const [options, setOptions] = useState<ImportOptions>({
    paths: [],
    categoryId: null,
    newCategoryName: '',
    preserveFolders: true,
    tags: true,
    aiExcluded: false,
    aiCues: false,
    importChanged: false
  })
  const { data: scan } = useQuery({
    queryKey: ['import-scan', scanId],
    queryFn: () => api.importer.scan(scanId!),
    enabled: open && !!scanId,
    refetchInterval: (q) => (['queued', 'scanning'].includes(q.state.data?.status ?? '') ? 300 : false)
  })
  const { data: run } = useQuery({
    queryKey: ['import-run', runId],
    queryFn: () => api.importer.run(runId!),
    enabled: open && !!runId,
    refetchInterval: (q) => (['queued', 'running', 'canceling'].includes(q.state.data?.status ?? '') ? 300 : false)
  })
  const { data: categories = [] } = useQuery({
    queryKey: ['categories', 'note'],
    queryFn: () => api.categories.list('note'),
    enabled: open
  })
  const { data: history = [] } = useQuery({
    queryKey: ['import-history'],
    queryFn: () => api.importer.history(),
    enabled: open && step === 'history'
  })
  const { data: estimate } = useQuery({
    queryKey: ['import-estimate', scanId, [...selected].sort()],
    queryFn: () => api.importer.estimate(scanId!, [...selected]),
    enabled: open && step === 'options' && !!scanId
  })
  useEffect(() => {
    if (!open) return
    return window.jiweiEvents.on('importer:changed', () => {
      void qc.invalidateQueries({ queryKey: ['import-scan'] })
      void qc.invalidateQueries({ queryKey: ['import-run'] })
      void qc.invalidateQueries({ queryKey: ['import-history'] })
    })
  }, [open, qc])
  const attempt = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch {
      setError(t('importer.errors'))
    } finally {
      setBusy(false)
    }
  }
  const choose = (mode: 'folder' | 'files'): Promise<void> =>
    attempt(async () => {
      const result = await api.importer.choose(mode)
      if (!result) return
      setScanId(result.id)
      setRunId(null)
      setValue(null)
      setStep('preview')
      // The native picker starts a background scan; default selection is established when it finishes.
      setSelected(new Set())
      setOptions((o) => ({ ...o, newCategoryName: t('importer.defaultCategory', { name: result.label }), categoryId: null }))
    })
  const [initializedScan, setInitializedScan] = useState<string | null>(null)
  useEffect(() => {
    if (scan?.status === 'ready' && initializedScan !== scan.id) {
      setInitializedScan(scan.id)
      setSelected(new Set(scan.entries.filter((e) => e.status === 'new').map((e) => e.path)))
      setOptions((o) => ({ ...o, newCategoryName: t('importer.defaultCategory', { name: scan.label }) }))
    }
  }, [scan, initializedScan, t])
  const toggle = (paths: string[], checked: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const p of paths) {
        if (checked) next.add(p)
        else next.delete(p)
      }
      return next
    })
  const running = run && ['queued', 'running', 'canceling'].includes(run.status)
  const reset = (): void => {
    setStep('choose')
    setScanId(null)
    setRunId(null)
    setError('')
    setValue(null)
    setCueMessage(false)
  }
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        className="no-drag"
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        <FolderInput />
        {t('importer.entry')}
      </Button>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" />
        <D.Content
          data-testid="import-wizard"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] w-[min(900px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-2xl [overflow-wrap:anywhere]"
        >
          <header className="flex items-center gap-3 border-b border-border px-5 py-4">
            <D.Title className="flex-1 font-serif text-lg">{t('importer.title')}</D.Title>
            <D.Close asChild>
              <Button size="icon" variant="ghost" aria-label={t('importer.close')}>
                <X />
              </Button>
            </D.Close>
          </header>
          <D.Description className="px-5 pt-4 text-sm text-muted">{t('importer.intro')}</D.Description>
          <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            {step === 'choose' && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void choose('folder')}>
                  {t('importer.folder')}
                </Button>
                <Button disabled={busy} variant="outline" onClick={() => void choose('files')}>
                  {t('importer.files')}
                </Button>
                <Button variant="ghost" onClick={() => setStep('history')}>
                  {t('importer.history')}
                </Button>
              </div>
            )}
            {step === 'preview' && scan && (
              <>
                {['queued', 'scanning'].includes(scan.status) && (
                  <div role="status" className="space-y-2">
                    <p className="flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" />
                      {t('importer.scan')}
                    </p>
                    <progress className="w-full" value={scan.progress} max={1} />
                    <Button size="sm" variant="outline" onClick={() => void attempt(() => api.importer.cancelScan(scan.id))}>
                      {t('importer.cancel')}
                    </Button>
                  </div>
                )}
                {scan.status === 'ready' && (
                  <>
                    <p className="text-sm">
                      {scan.kind} · {scan.label}
                    </p>
                    <p className="text-sm">{t('importer.stats', scan.stats)}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mr-auto text-sm text-muted">{t('importer.selected', { count: selected.size })}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          toggle(
                            scan.entries.map((e) => e.path),
                            true
                          )
                        }
                      >
                        {t('importer.selectAll')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                        {t('importer.clear')}
                      </Button>
                    </div>
                    <Tree
                      entries={scan.entries}
                      selected={selected}
                      toggle={toggle}
                      preview={(path) => void attempt(async () => setValue(await api.importer.preview(scan.id, path)))}
                    />
                    <Issues issues={scan.issues} />
                    {value && (
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium">
                          {value.title} · {t('importer.previewTitle')}
                        </h3>
                        <p className="text-xs text-muted">{t('importer.previewHint')}</p>
                        <ImportPreview key={value.title} value={value} />
                      </div>
                    )}
                    <Button disabled={!selected.size || busy} onClick={() => setStep('options')}>
                      {t('importer.next')}
                    </Button>
                  </>
                )}
                {['failed', 'canceled'].includes(scan.status) && (
                  <p role="alert">{t(scan.status === 'failed' ? 'importer.errors' : 'importer.canceled')}</p>
                )}
                <Button size="sm" variant="ghost" onClick={reset}>
                  {t('importer.folder')}
                </Button>
              </>
            )}
            {step === 'options' && scan && (
              <div className="space-y-4 text-sm">
                <label className="block space-y-1">
                  <span>{t('importer.destination')}</span>
                  <select
                    className="w-full rounded border border-border bg-surface p-2"
                    value={options.categoryId ?? ''}
                    onChange={(e) => setOptions({ ...options, categoryId: e.target.value || null })}
                  >
                    <option value="">{t('importer.newCategory')}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                {!options.categoryId && (
                  <label className="block space-y-1">
                    <span>{t('importer.categoryName')}</span>
                    <Input
                      value={options.newCategoryName}
                      maxLength={200}
                      onChange={(e) => setOptions({ ...options, newCategoryName: e.target.value })}
                    />
                  </label>
                )}
                {(['preserveFolders', 'tags', 'aiExcluded', 'aiCues', 'importChanged'] as const).map((key) => (
                  <div key={key}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={options[key]}
                        disabled={key === 'aiCues' && (options.aiExcluded || !estimate?.available)}
                        onChange={(e) => {
                          const v = e.target.checked
                          setOptions({ ...options, [key]: v, ...(key === 'aiExcluded' && v ? { aiCues: false } : {}) })
                          if (key === 'importChanged' && v)
                            toggle(
                              scan.entries.filter((e) => e.status === 'changed').map((e) => e.path),
                              true
                            )
                        }}
                      />
                      {t(
                        `importer.${{ preserveFolders: 'folders', tags: 'tags', aiExcluded: 'private', aiCues: 'cues', importChanged: 'changedOption' }[key]}`
                      )}
                    </label>
                    {key === 'aiExcluded' && <p className="mt-1 pl-6 text-xs text-muted">{t('importer.privateHint')}</p>}
                    {key === 'aiCues' && (
                      <p className="mt-1 pl-6 text-xs text-muted">
                        {t('importer.cueHint')}
                        {estimate && (
                          <span className="mt-1 block">
                            {!estimate.available
                              ? t('importer.noModel')
                              : estimate.cost === null
                                ? t('importer.unknownCost', { calls: estimate.calls })
                                : t('importer.estimate', { calls: estimate.calls, cost: estimate.cost.toFixed(4) })}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                ))}
                <p className="text-xs text-muted">{t('importer.unchangedHint')}</p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep('preview')}>
                    {t('importer.back')}
                  </Button>
                  <Button
                    disabled={busy || !selected.size || !options.newCategoryName.trim()}
                    onClick={() =>
                      void attempt(async () => {
                        const r = await api.importer.start(scan.id, { ...options, paths: [...selected] })
                        setRunId(r.id)
                        setStep('run')
                      })
                    }
                  >
                    {t('importer.start')}
                  </Button>
                </div>
              </div>
            )}
            {step === 'run' && run && (
              <div className="space-y-4" data-testid={running ? 'import-progress' : 'import-result'} data-run-id={run.id}>
                <h3 className="font-medium">
                  {t(running ? (run.status === 'canceling' ? 'importer.canceling' : 'importer.importing') : 'importer.result')}
                </h3>
                {running && (
                  <>
                    <progress className="w-full" value={run.progress} max={1} />
                    <p className="text-xs text-muted">{t('importer.background')}</p>
                    <Button
                      size="sm"
                      disabled={run.status === 'canceling'}
                      variant="outline"
                      onClick={() => void attempt(() => api.importer.cancel(run.id))}
                    >
                      {t('importer.cancel')}
                    </Button>
                  </>
                )}
                <p className="text-sm">
                  {t('importer.counts', {
                    success: run.items.filter((i) => i.status === 'imported').length,
                    skipped: run.items.filter((i) => i.status === 'skipped').length,
                    failed: run.items.filter((i) => i.status === 'failed').length
                  })}
                </p>
                {run.status === 'canceled' && <p className="text-sm">{t('importer.canceled')}</p>}
                {run.status === 'failed' && <p role="alert">{t('importer.failed')}</p>}
                {run.tasks > 0 && <p className="text-sm">{t('importer.tasks', { count: run.tasks })}</p>}
                <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
                  {run.items.map((item) => (
                    <li key={item.path} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 font-mono text-xs">{item.path}</span>
                      {item.status === 'imported' && item.noteId && !run.undoneAt ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            useApp.getState().openNote(item.noteId!)
                            setOpen(false)
                          }}
                        >
                          {t('importer.view', {
                            title:
                              scan?.entries.find((e) => e.path === item.path)?.title ??
                              item.path.replace(/.*\//, '').replace(/\.[^.]+$/, '')
                          })}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted">
                          {t(item.status === 'failed' ? 'importer.itemFailed' : 'importer.skipped')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <Issues issues={run.issues} />
                {!running &&
                  (run.undoneAt ? (
                    <p className="text-sm">{t('importer.undone')}</p>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void attempt(async () => {
                          if (
                            await confirm({
                              title: t('importer.undoTitle'),
                              description: t('importer.undoHint'),
                              confirmText: t('importer.undo')
                            })
                          ) {
                            await api.importer.undo(run.id)
                            void qc.invalidateQueries()
                          }
                        })
                      }
                    >
                      {t('importer.undo')}
                    </Button>
                  ))}
                {run.cueJobIds.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void attempt(async () => {
                        await api.importer.cancelCues(run.id)
                        setCueMessage(true)
                      })
                    }
                  >
                    {t('importer.cancelCues')}
                  </Button>
                )}
                {cueMessage && <p className="text-xs">{t('importer.cuesCanceled')}</p>}
                <p className="text-xs text-muted">{t('importer.attachmentsHint')}</p>
                <Button variant="ghost" onClick={reset}>
                  {t('importer.entry')}
                </Button>
              </div>
            )}
            {step === 'history' && (
              <div className="space-y-2">
                {!history.length && <p>{t('importer.historyEmpty')}</p>}
                {history.map((r) => (
                  <button
                    key={r.id}
                    className="block w-full rounded border border-border p-3 text-left text-sm"
                    onClick={() => {
                      setRunId(r.id)
                      setScanId(r.scanId)
                      setStep('run')
                    }}
                  >
                    {r.label} · {r.kind} · {new Date(r.createdAt).toLocaleString()} · {r.undoneAt ? t('importer.undone') : r.items.length}
                  </button>
                ))}
                <Button variant="ghost" onClick={reset}>
                  {t('importer.entry')}
                </Button>
              </div>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
