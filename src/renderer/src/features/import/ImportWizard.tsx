import { NativeSelect } from '@/components/ui/native-select'
import { Checkbox } from '@/components/ui/checkbox'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DialogParts as D } from '@/components/ui/dialog'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileArchive,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  Loader2,
  ShieldCheck,
  Undo2,
  X
} from 'lucide-react'
import { api, cn } from '@/lib/utils'
import { useMoney } from '@/lib/money'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/shadcn-button'
import { Input } from '@/components/ui/shadcn-primitives'
import { confirm, useConfirmSignal, withActionLock } from '@/components/ui/shadcn-confirm'
import { ImportPreview } from './ImportPreview'
import type { ImportEntry, ImportIssue, ImportOptions, ImportPreview as Preview, ImportRun } from '@shared/importer'

function Issues({ issues }: { issues: ImportIssue[] }) {
  const { t } = useTranslation(),
    [limit, setLimit] = useState(50)
  if (!issues.length) return null
  return (
    <details className="group rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-fg">
        <AlertTriangle className="size-4 shrink-0 text-warning" />
        <span className="flex-1">
          {t('importer.issueTitle')} ({issues.length})
        </span>
        <ChevronRight className="size-4 text-subtle transition-transform group-open:rotate-90" />
      </summary>
      <ul className="mt-2 space-y-1 text-xs text-muted">
        {issues.slice(0, limit).map((issue, i) => (
          <li key={i}>
            {issue.path && <span className="font-mono text-fg/80">{issue.path}</span>}
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
    </details>
  )
}
function Tree({
  entries,
  selected,
  toggle,
  preview,
  active
}: {
  entries: ImportEntry[]
  active: string | null
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
            <details key={path} open className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-surface-hover">
                <ChevronRight className="size-3.5 shrink-0 text-subtle transition-transform group-open:rotate-90" />
                <Checkbox
                  className="accent-[var(--color-accent)]"
                  aria-label={t('importer.folderLabel', { name: path.slice(0, -1) })}
                  checked={count > 0 && count < paths.length ? 'indeterminate' : count === paths.length}
                  onCheckedChange={(next) => toggle(paths, next === true)}
                />
                <Folder className="size-4 shrink-0 text-subtle" />
                <span className="min-w-0 flex-1 truncate">{folder}</span>
                <span className="text-xs text-subtle tabular-nums">
                  {count}/{paths.length}
                </span>
              </summary>
              <div className="ml-3 border-l border-border pl-2">{render(path)}</div>
            </details>
          )
        })}
        {direct.slice(0, limit).map((e) => (
          <div
            key={e.path}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-surface-hover',
              active === e.path && 'bg-accent-soft hover:bg-accent-soft'
            )}
          >
            <Checkbox

              className="accent-[var(--color-accent)]"
              aria-label={e.path}
              checked={selected.has(e.path)}
              onCheckedChange={(nextChecked) => toggle([e.path], (nextChecked === true))}
            />
            <Button variant="ghost" size="auto"
              className="min-w-0 flex-1 text-left hover:text-accent"
              aria-label={t('importer.preview', { title: e.title })}
              onClick={() => preview(e.path)}
            >
              <span className="block truncate">{e.title}</span>
              {e.path !== `${e.title}.md` && <span className="block truncate font-mono text-[11px] text-subtle">{e.path}</span>}
            </Button>
            {e.status !== 'new' && (
              <span className={cn('shrink-0 text-xs', e.status === 'changed' ? 'text-warning' : 'text-subtle')}>
                {t(`importer.statuses.${e.status}`)}
              </span>
            )}
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
    <div data-testid="import-tree" className="min-h-0 flex-1 overflow-y-auto p-2">
      {render('')}
    </div>
  )
}

export function ImportLibraryButton() {
  const confirmSignal = useConfirmSignal('import-library')
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
    [cueMessage, setCueMessage] = useState(false),
    [activePath, setActivePath] = useState<string | null>(null)
  const money = useMoney()
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
  const { data: recent = [] } = useQuery({
    queryKey: ['import-history'],
    queryFn: () => api.importer.history(),
    enabled: open && (step === 'history' || step === 'choose')
  })
  const openRun = (r: ImportRun): void => {
    setRunId(r.id)
    setScanId(r.scanId)
    setStep('run')
  }
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
  const choose = (mode: 'folder' | 'files' | 'notion' | 'notion-folder'): Promise<void> =>
    attempt(async () => {
      const result = await api.importer.choose(mode)
      if (!result) return
      setScanId(result.id)
      setRunId(null)
      setValue(null)
      setActivePath(null)
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
    setOptions({
      paths: [],
      categoryId: null,
      newCategoryName: '',
      preserveFolders: true,
      tags: true,
      aiExcluded: false,
      aiCues: false,
      importChanged: false
    })
    setStep('choose')
    setScanId(null)
    setRunId(null)
    setError('')
    setValue(null)
    setActivePath(null)
    setCueMessage(false)
  }
  const check = (key: 'preserveFolders' | 'tags' | 'aiExcluded' | 'aiCues' | 'importChanged', hint?: React.ReactNode) => (
    <div>
      <label className="flex items-start gap-2.5">
        <Checkbox

          className="mt-0.5 size-4 accent-[var(--color-accent)]"
          checked={options[key]}
          disabled={key === 'aiCues' && (options.aiExcluded || !estimate?.available)}
          onCheckedChange={(nextChecked) => {
            const v = (nextChecked === true)
            setOptions({ ...options, [key]: v, ...(key === 'aiExcluded' && v ? { aiCues: false } : {}) })
            if (key === 'importChanged' && v && scan)
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
      {hint && <p className="mt-1 pl-6.5 text-xs leading-relaxed text-muted">{hint}</p>}
    </div>
  )
  const stepIndex = { choose: 0, history: 0, preview: 1, options: 2, run: 3 }[step]
  const counts = run
    ? {
        imported: run.items.filter((i) => i.status === 'imported').length,
        skipped: run.items.filter((i) => i.status === 'skipped').length,
        failed: run.items.filter((i) => i.status === 'failed').length
      }
    : null
  const titleOf = (path: string): string =>
    scan?.entries.find((e) => e.path === path)?.title ?? path.replace(/.*\//, '').replace(/\.[^.]+$/, '')
  const source = (mode: 'folder' | 'files' | 'notion', Icon: typeof FolderOpen, title: string, desc: string, extra?: React.ReactNode) => (
    <div className="flex flex-col rounded-xl border border-border bg-surface transition-colors hover:border-accent/50 hover:bg-surface-hover">
      <Button variant="ghost" size="auto"
        disabled={busy}
        aria-label={t(`importer.${mode}`)}
        className="flex flex-1 flex-col items-start gap-2 p-4 text-left disabled:opacity-60"
        onClick={() => void choose(mode)}
      >
        <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent">
          <Icon className="size-5" />
        </span>
        <span className="font-medium text-fg">{title}</span>
        <span className="text-xs leading-relaxed text-muted">{desc}</span>
      </Button>
      {extra}
    </div>
  )
  const footer = (children: React.ReactNode) => (
    <footer className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">{children}</footer>
  )
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <Button
        variant="secondary"
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
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] w-[min(1040px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-2xl [overflow-wrap:anywhere]',
            step === 'preview' && scan?.status === 'ready' && 'h-[88vh]'
          )}
        >
          <header className="flex items-center gap-4 border-b border-border px-5 py-3">
            <div className="min-w-0 flex-1">
              <D.Title className="font-serif text-lg">{t('importer.title')}</D.Title>
              <D.Description className="text-xs text-muted">{t('importer.intro')}</D.Description>
            </div>
            <ol aria-label={t('importer.stepLabel', { n: stepIndex + 1 })} className="hidden items-center gap-1.5 text-xs sm:flex">
              {(['source', 'preview', 'options', 'run'] as const).map((k, n) => (
                <li key={k} className="flex items-center gap-1.5">
                  {n > 0 && <span className="h-px w-4 bg-border" />}
                  <span
                    aria-current={n === stepIndex ? 'step' : undefined}
                    className={cn(
                      'flex items-center gap-1 rounded-full px-2 py-0.5',
                      n === stepIndex ? 'bg-accent-soft font-medium text-accent' : n < stepIndex ? 'text-muted' : 'text-subtle'
                    )}
                  >
                    {n < stepIndex ? <Check className="size-3" /> : <span className="tabular-nums">{n + 1}</span>}
                    {t(`importer.steps.${k}`)}
                  </span>
                </li>
              ))}
            </ol>
            <D.Close asChild>
              <Button size="icon" variant="ghost" aria-label={t('importer.close')}>
                <X />
              </Button>
            </D.Close>
          </header>
          {error && (
            <p role="alert" className="border-b border-danger/20 bg-danger/5 px-5 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          {step === 'choose' && (
            <div className="min-h-0 space-y-6 overflow-y-auto px-5 py-5">
              <div className="grid gap-3 sm:grid-cols-3">
                {source('folder', FolderOpen, t('importer.sources.folderTitle'), t('importer.sources.folderBody'))}
                {source('files', FileText, t('importer.sources.filesTitle'), t('importer.sources.filesBody'))}
                {source(
                  'notion',
                  FileArchive,
                  t('importer.sources.notionTitle'),
                  t('importer.sources.notionBody'),
                  <Button variant="ghost" size="auto"
                    disabled={busy}
                    aria-label={t('importer.notionFolder')}
                    className="border-t border-border px-4 py-2 text-left text-xs text-accent hover:underline disabled:opacity-60"
                    onClick={() => void choose('notion-folder')}
                  >
                    {t('importer.sources.notionFolderLink')}
                  </Button>
                )}
              </div>
              <p className="flex items-center gap-2 text-xs text-muted">
                <ShieldCheck className="size-4 shrink-0 text-accent" />
                {t('importer.safe')}
              </p>
              {recent.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center">
                    <h3 className="flex-1 text-sm font-medium">{t('importer.recent')}</h3>
                    {recent.length > 3 && (
                      <Button size="sm" variant="ghost" onClick={() => setStep('history')}>
                        {t('importer.allHistory')}
                      </Button>
                    )}
                  </div>
                  <HistoryList runs={recent.slice(0, 3)} onOpen={openRun} />
                </section>
              )}
            </div>
          )}

          {step === 'history' && (
            <>
              <div className="min-h-0 space-y-2 overflow-y-auto px-5 py-4">
                <h3 className="text-sm font-medium">{t('importer.history')}</h3>
                {!recent.length && <p className="text-sm text-muted">{t('importer.historyEmpty')}</p>}
                <HistoryList runs={recent} onOpen={openRun} />
              </div>
              {footer(
                <Button variant="ghost" onClick={reset}>
                  <ArrowLeft />
                  {t('importer.steps.source')}
                </Button>
              )}
            </>
          )}

          {step === 'preview' && scan && (
            <>
              {['queued', 'scanning'].includes(scan.status) && (
                <div role="status" className="space-y-3 px-5 py-10 text-center">
                  <Loader2 className="mx-auto size-6 animate-spin text-accent" />
                  <p className="text-sm">{t('importer.scan')}</p>
                  <Bar value={scan.progress} />
                  <Button size="sm" variant="secondary" onClick={() => void attempt(() => api.importer.cancelScan(scan.id))}>
                    {t('importer.cancel')}
                  </Button>
                </div>
              )}
              {['failed', 'canceled'].includes(scan.status) && (
                <div className="space-y-4 px-5 py-8">
                  <p role="alert" className="text-sm">
                    {scan.status === 'failed' ? t(`importer.scanErrors.${scan.error ?? 'scan-failed'}`) : t('importer.canceled')}
                  </p>
                  <Button variant="secondary" onClick={reset}>
                    <ArrowLeft />
                    {t('importer.steps.source')}
                  </Button>
                </div>
              )}
              {scan.status === 'ready' && (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-2.5 text-sm">
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-xs text-muted">{t(`importer.kinds.${scan.kind}`)}</span>
                    <span className="font-medium">{scan.label}</span>
                    <span className="text-muted">{t('importer.stats', scan.stats)}</span>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                    <div className="flex min-h-0 flex-col border-border md:w-[42%] md:border-r">
                      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
                        <span className="mr-auto text-xs text-muted">{t('importer.selected', { count: selected.size })}</span>
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
                        active={activePath}
                        preview={(path) =>
                          void attempt(async () => {
                            setActivePath(path)
                            setValue(await api.importer.preview(scan.id, path))
                          })
                        }
                      />
                      {scan.issues.length > 0 && (
                        <div className="border-t border-border p-2">
                          <Issues issues={scan.issues} />
                        </div>
                      )}
                    </div>
                    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-sunken/40 p-4">
                      {value ? (
                        <div className="space-y-2">
                          <h3 className="text-sm font-medium">
                            {value.title} · {t('importer.previewTitle')}
                          </h3>
                          <p className="text-xs text-muted">{t('importer.previewHint')}</p>
                          <ImportPreview key={value.title} value={value} />
                        </div>
                      ) : (
                        <div className="grid h-full min-h-40 place-items-center text-center text-sm text-subtle">
                          <div>
                            <Eye className="mx-auto mb-2 size-6" />
                            {t('importer.pickPreview')}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  {footer(
                    <>
                      <Button variant="ghost" onClick={reset}>
                        <ArrowLeft />
                        {t('importer.steps.source')}
                      </Button>
                      <span className="mr-auto" />
                      <Button variant="primary" disabled={!selected.size || busy} onClick={() => setStep('options')}>
                        {t('importer.next')}
                      </Button>
                    </>
                  )}
                </>
              )}
            </>
          )}

          {step === 'options' && scan && (
            <>
              <div className="min-h-0 space-y-5 overflow-y-auto px-5 py-5 text-sm">
                <Group title={t('importer.optionsGroupWhere')}>
                  <label className="block space-y-1">
                    <span className="text-muted">{t('importer.destination')}</span>
                    <NativeSelect
                      className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
                      value={options.categoryId ?? ''}
                      onChange={(e) => setOptions({ ...options, categoryId: e.target.value || null })}
                    >
                      <option value="">{t('importer.newCategory')}</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  {!options.categoryId && (
                    <label className="block space-y-1">
                      <span className="text-muted">{t('importer.categoryName')}</span>
                      <Input
                        value={options.newCategoryName}
                        maxLength={200}
                        onChange={(e) => setOptions({ ...options, newCategoryName: e.target.value })}
                      />
                    </label>
                  )}
                  {check('preserveFolders')}
                </Group>
                <Group title={t('importer.optionsGroupContent')}>
                  {check('tags')}
                  {scan.entries.some((e) => e.status === 'changed') && check('importChanged')}
                  <p className="text-xs text-muted">{t('importer.unchangedHint')}</p>
                </Group>
                <Group title={t('importer.optionsGroupAi')}>
                  {check('aiExcluded', t('importer.privateHint'))}
                  {check(
                    'aiCues',
                    <>
                      {t('importer.cueHint')}
                      {estimate && (
                        <span className="mt-1 block text-fg/80">
                          {!estimate.available
                            ? t('importer.noModel')
                            : estimate.cost === null
                              ? t('importer.unknownCost', { calls: estimate.calls })
                              : t('importer.estimate', { calls: estimate.calls, cost: money.format(estimate.cost) })}
                        </span>
                      )}
                    </>
                  )}
                </Group>
              </div>
              {footer(
                <>
                  <Button variant="ghost" onClick={() => setStep('preview')}>
                    <ArrowLeft />
                    {t('importer.back')}
                  </Button>
                  <span className="mr-auto" />
                  <span className="text-xs text-muted">{t('importer.selected', { count: selected.size })}</span>
                  <Button
                    variant="primary"
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
                </>
              )}
            </>
          )}

          {step === 'run' && run && counts && (
            <>
              <div
                className="min-h-0 space-y-4 overflow-y-auto px-5 py-5"
                data-testid={running ? 'import-progress' : 'import-result'}
                data-run-id={run.id}
              >
                <h3 className="flex items-center gap-2 font-medium">
                  {running ? (
                    <Loader2 className="size-4 animate-spin text-accent" />
                  ) : run.status === 'done' && !run.undoneAt ? (
                    <CheckCircle2 className="size-5 text-accent" />
                  ) : null}
                  {t(running ? (run.status === 'canceling' ? 'importer.canceling' : 'importer.importing') : 'importer.result')}
                  <span className="text-sm font-normal text-muted">· {run.label}</span>
                </h3>
                {running && (
                  <div className="space-y-2">
                    <Bar value={run.progress} />
                    <p className="text-xs text-muted">
                      {t('importer.progress', { percent: Math.round(run.progress * 100) })} · {t('importer.background')}
                    </p>
                  </div>
                )}
                <p className="sr-only">
                  {t('importer.counts', { success: counts.imported, skipped: counts.skipped, failed: counts.failed })}
                </p>
                <div className="grid grid-cols-3 gap-2" aria-hidden>
                  {(
                    [
                      ['imported', counts.imported, 'text-fg'],
                      ['skippedCount', counts.skipped, 'text-muted'],
                      ['failedCount', counts.failed, counts.failed ? 'text-danger' : 'text-muted']
                    ] as const
                  ).map(([k, n, tone]) => (
                    <div key={k} className="rounded-lg border border-border px-3 py-2">
                      <div className={cn('font-serif text-2xl tabular-nums', tone)}>{n}</div>
                      <div className="text-xs text-muted">{t(`importer.${k}`)}</div>
                    </div>
                  ))}
                </div>
                {run.status === 'canceled' && <p className="text-sm">{t('importer.canceled')}</p>}
                {run.status === 'failed' && (
                  <p role="alert" className="text-sm text-danger">
                    {t('importer.failed')}
                  </p>
                )}
                {run.undoneAt && <p className="text-sm text-muted">{t('importer.undone')}</p>}
                {run.tasks > 0 && !run.undoneAt && <p className="text-sm">{t('importer.tasks', { count: run.tasks })}</p>}
                {run.items.length > 0 && (
                  <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm">
                    {run.items.map((item) => (
                      <li key={item.path} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{titleOf(item.path)}</span>
                          <span className="block truncate font-mono text-[11px] text-subtle">{item.path}</span>
                        </span>
                        {item.status === 'imported' && item.noteId && !run.undoneAt ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('importer.view', { title: titleOf(item.path) })}
                            onClick={() => {
                              useApp.getState().openNote(item.noteId!)
                              setOpen(false)
                            }}
                          >
                            {t('importer.open')}
                            <ArrowRight />
                          </Button>
                        ) : item.status !== 'imported' ? (
                          <span className={cn('shrink-0 text-xs', item.status === 'failed' ? 'text-danger' : 'text-subtle')}>
                            {t(item.status === 'failed' ? 'importer.itemFailed' : 'importer.skipped')}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                <Issues issues={run.issues} />
                {run.cueJobIds.length > 0 && !cueMessage && (
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
                {cueMessage && <p className="text-xs text-muted">{t('importer.cuesCanceled')}</p>}
              </div>
              {footer(
                running ? (
                  <>
                    <span className="mr-auto" />
                    <Button
                      variant="secondary"
                      disabled={run.status === 'canceling'}
                      onClick={() => void attempt(() => api.importer.cancel(run.id))}
                    >
                      {t('importer.cancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    {!run.undoneAt && counts.imported > 0 && (
                      <Button
                        variant="ghost"
                        className="text-danger hover:text-danger"
                        disabled={busy}
                        title={t('importer.attachmentsHint')}
                        onClick={() =>
                          void attempt(async () => {
                            const operationKey = `import:${run.id}:undo`
                            await withActionLock(operationKey, async () => {
                              if (
                                await confirm({
                                  operationKey,
                                  signal: confirmSignal,
                                  title: t('importer.undoTitle'),
                                  description: t('importer.undoHint'),
                                  confirmText: t('importer.undo')
                                })
                              ) {
                                if (confirmSignal.aborted) return
                                await api.importer.undo(run.id)
                                void qc.invalidateQueries()
                              }
                            }, { signal: confirmSignal })
                          })
                        }
                      >
                        <Undo2 />
                        {t('importer.undo')}
                      </Button>
                    )}
                    <span className="mr-auto" />
                    <Button variant="secondary" onClick={reset}>
                      {t('importer.again')}
                    </Button>
                    <Button variant="primary" onClick={() => setOpen(false)}>
                      {t('importer.done')}
                    </Button>
                  </>
                )
              )}
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={Math.round(value * 100)}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(3, value * 100)}%` }} />
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h3 className="text-xs font-medium tracking-wide text-subtle">{title}</h3>
      {children}
    </section>
  )
}

function HistoryList({ runs, onOpen }: { runs: ImportRun[]; onOpen: (run: ImportRun) => void }) {
  const { t, i18n } = useTranslation()
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {runs.map((r) => (
        <li key={r.id}>
          <Button variant="ghost" size="auto" className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover" onClick={() => onOpen(r)}>
            <span className="rounded bg-sunken px-1.5 py-0.5 text-xs text-muted">{t(`importer.kinds.${r.kind}`)}</span>
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="shrink-0 text-xs text-subtle">
              {r.undoneAt
                ? t('importer.undone').split(/[，,.]/)[0]
                : t('importer.historyItem', { count: r.items.filter((i) => i.status === 'imported').length })}
              {' · '}
              {new Date(r.createdAt).toLocaleDateString(i18n.language)}
            </span>
            <ChevronRight className="size-4 shrink-0 text-subtle" />
          </Button>
        </li>
      ))}
    </ul>
  )
}
