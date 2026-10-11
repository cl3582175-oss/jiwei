import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Check, ChevronDown, Dumbbell, ImagePlus, Loader2, MoreHorizontal, NotebookText, Pencil, Plus, RotateCcw, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { MistakeCauseSchema, MistakeSubjectSchema, type Mistake, type MistakeFilters, type MistakePatch, type MistakeSubject } from '@shared/mistakes'
import type { Job } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/primitives'
import { errText } from '../chat/useChat'
import { landMistake, removeMistake } from './documents'
import { RichMistake } from './RichMistake'
import { MistakePracticeDialog } from './PracticeDialog'
import { useProvidePageContext } from '../assist/pageContext'

// 错题本（复习页的一个标签）：左侧列表，右侧详情。详情默认是“读”的样子——题目、我的答案、
// 错因、正确解法依次排开，公式渲染好；需要改时再点“编辑”展开表单。

const TINT: Record<MistakeSubject, string> = { math: 'sky', physics: 'lotus', chemistry: 'apricot', english: 'bamboo', other: 'moon' }
const fieldStyle = 'block w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-fg outline-none transition-colors focus:border-accent'
const selectStyle = 'h-9 min-w-0 rounded-lg border border-border bg-surface px-2.5 text-sm text-fg outline-none focus:border-accent'
const FLAG_KEY: Record<string, string> = { 'recognition-uncertain': 'recognitionUncertain', 'needs-recognition': 'needsRecognition', 'no-model': 'noModel', 'local-only': 'localOnly', canceled: 'canceled', failed: 'failed' }

function AddDialog({ open, close, added }: { open: boolean; close: () => void; added: (id: string) => void }) {
  const { t } = useTranslation(), input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(''), [image, setImage] = useState<File | null>(null), [preview, setPreview] = useState<string | null>(null), [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!image) { setPreview(null); return }
    const url = URL.createObjectURL(image)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [image])
  const imageFile = (file: File | undefined): void => {
    if (!file) return
    if (!file.type.startsWith('image/') || file.size > 25 * 1024 * 1024) { toast.error(t('mistakes.needsRecognition')); return }
    setImage(file)
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const asset = image ? await api.assets.importBytes(image.name, image.type, new Uint8Array(await image.arrayBuffer())) : null
      const result = await api.mistakes.create({ sourceKind: 'manual', text, assetId: asset?.id, requestId: crypto.randomUUID() })
      if (result.items[0]) added(result.items[0].id)
      setImage(null); setText(''); close()
    } catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) close() }}><DialogContent title={t('mistakes.add')} description={t('mistakes.addHint')} className="max-h-[88vh] w-[min(92vw,560px)] overflow-y-auto">
    <div className={cn('mt-5 grid min-h-40 place-items-center rounded-xl border border-dashed border-border-strong bg-sunken/60 p-5 text-center transition-colors focus-within:border-accent', preview && 'p-3')} tabIndex={0}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); imageFile(e.dataTransfer.files[0]) }}
      onPaste={(e) => { const file = [...e.clipboardData.items].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile(); if (file) { e.preventDefault(); imageFile(file) } }} data-testid="mistake-image-input">
      <input ref={input} aria-label={t('mistakes.selectImage')} type="file" accept="image/*" className="sr-only" onChange={(e) => imageFile(e.target.files?.[0])} />
      {preview ? <div className="relative w-full">
        <img src={preview} alt={t('mistakes.selectedImage')} className="mx-auto max-h-56 rounded-lg object-contain" />
        <button type="button" aria-label={t('mistakes.cancel')} onClick={() => setImage(null)} className="absolute top-1 right-1 grid size-7 place-items-center rounded-full bg-surface/90 text-muted shadow-card hover:text-fg"><X className="size-4" /></button>
      </div> : <div>
        <ImagePlus className="mx-auto size-8 text-subtle" strokeWidth={1.5} />
        <p className="mt-2 text-sm text-muted">{t('mistakes.dropHint')}</p>
        <Button className="mt-3" variant="outline" size="sm" onClick={() => input.current?.click()}>{t('mistakes.selectImage')}</Button>
      </div>}
    </div>
    <label className="mt-5 block text-sm font-medium text-fg">{t('mistakes.addText')}<textarea className={cn(fieldStyle, 'mt-2 resize-y')} rows={5} value={text} maxLength={12000} onChange={(e) => setText(e.target.value)} placeholder={t('mistakes.addPlaceholder')} /></label>
    <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={close}>{t('reading.cancel')}</Button><Button variant="primary" disabled={busy || (!image && !text.trim())} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : <Plus />}{t(busy ? 'mistakes.saving' : 'mistakes.create')}</Button></div>
  </DialogContent></Dialog>
}

/** 详情里的一节：小标题 + 内容；tone 决定左侧色条（我的答案红、正确解法绿）。 */
function Section({ label, tone, extra, children }: { label: string; tone?: 'wrong' | 'right'; extra?: ReactNode; children: ReactNode }) {
  return <section className="min-w-0">
    <div className="mb-2 flex items-center gap-2"><h3 className="text-xs font-semibold tracking-wide text-muted">{label}</h3>{extra}</div>
    <div className={cn('min-w-0', tone && 'border-l-[3px] pl-4', tone === 'wrong' && 'border-danger/50', tone === 'right' && 'border-accent/60')}>{children}</div>
  </section>
}

function Editor({ m, busy, save, cancel }: { m: Mistake; busy: boolean; save: (patch: MistakePatch) => void; cancel: () => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState({ question: m.question, myAnswer: m.myAnswer, correctAnswer: m.correctAnswer, solution: m.solution, cause: m.cause, causeReason: m.causeReason, subject: m.subject, concepts: m.concepts.join('，') })
  const submit = (): void => {
    const patch: MistakePatch = {}
    for (const k of ['question', 'myAnswer', 'correctAnswer', 'solution', 'cause', 'causeReason', 'subject'] as const) if (draft[k] !== m[k]) Object.assign(patch, { [k]: draft[k] })
    const concepts = [...new Set(draft.concepts.split(/[,，、]/).map((s) => s.trim()).filter(Boolean))]
    if (JSON.stringify(concepts) !== JSON.stringify(m.concepts)) patch.concepts = concepts
    save(patch)
  }
  return <fieldset disabled={busy} className="space-y-4 disabled:opacity-70" data-testid="mistake-editor">
    {(['question', 'myAnswer', 'correctAnswer', 'solution'] as const).map((k) => <label key={k} className="block text-sm font-medium text-fg">{t(`mistakes.${k}`)}<textarea aria-label={t(`mistakes.${k}`)} rows={k === 'question' || k === 'solution' ? 4 : 3} maxLength={12000} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} className={cn(fieldStyle, 'mt-1.5 resize-y font-mono text-[13px]')} /></label>)}
    <div className="grid grid-cols-2 gap-3">
      <label className="text-sm font-medium text-fg">{t('mistakes.subject')}<select aria-label={t('mistakes.subject')} className={cn(selectStyle, 'mt-1.5 block w-full')} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: MistakeSubjectSchema.parse(e.target.value) })}>{MistakeSubjectSchema.options.map((s) => <option key={s} value={s}>{t(`mistakes.subjectNames.${s}`)}</option>)}</select></label>
      <label className="text-sm font-medium text-fg">{t('mistakes.cause')}<select aria-label={t('mistakes.cause')} className={cn(selectStyle, 'mt-1.5 block w-full')} value={draft.cause} onChange={(e) => setDraft({ ...draft, cause: MistakeCauseSchema.parse(e.target.value) })}>{MistakeCauseSchema.options.map((s) => <option key={s} value={s}>{t(`mistakes.causeNames.${s}`)}</option>)}</select></label>
    </div>
    <label className="block text-sm font-medium text-fg">{t('mistakes.causeReason')}<textarea aria-label={t('mistakes.causeReason')} rows={2} className={cn(fieldStyle, 'mt-1.5 resize-y')} value={draft.causeReason} maxLength={1000} onChange={(e) => setDraft({ ...draft, causeReason: e.target.value })} /></label>
    <label className="block text-sm font-medium text-fg">{t('mistakes.concepts')}<Input aria-label={t('mistakes.concepts')} className="mt-1.5" value={draft.concepts} maxLength={124} placeholder={t('mistakes.conceptsHint')} onChange={(e) => setDraft({ ...draft, concepts: e.target.value })} /></label>
    <div className="flex justify-end gap-2 pt-1"><Button variant="ghost" onClick={cancel}>{t('reading.cancel')}</Button><Button variant="primary" onClick={submit}><Check />{t('mistakes.save')}</Button></div>
  </fieldset>
}

function Detail({ m, job, changed, back }: { m: Mistake; job?: Job; changed: () => void; back: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false), [practising, setPractising] = useState(false), [editing, setEditing] = useState(false)
  const processing = m.flags.includes('processing'), unverified = m.answerOrigin === 'ai' && !m.verified
  // 积微助手侧栏的页面上下文：这道错题（仅本地的题不附带）
  useProvidePageContext(
    m.flags.includes('local-only') || !m.question.trim()
      ? null
      : {
          title: t('mistakes.title'),
          text: [
            `${t('mistakes.question')}：${m.question}`,
            m.myAnswer && `${t('mistakes.myAnswer')}：${m.myAnswer}`,
            m.correctAnswer && `${t('mistakes.correctAnswer')}：${m.correctAnswer}`,
            m.causeReason && `${t('mistakes.cause')}（${t(`mistakes.causeNames.${m.cause}`)}）：${m.causeReason}`
          ]
            .filter(Boolean)
            .join('\n')
        }
  )
  const notices = m.flags.filter((f) => f !== 'processing' && FLAG_KEY[f])
  const retryable = !processing && m.flags.some((f) => ['needs-recognition', 'no-model', 'canceled', 'failed'].includes(f))
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    try { await fn(); changed(); return true } catch (e) { toast.error(errText(e)); return false } finally { setBusy(false) }
  }
  const save = (patch: MistakePatch): void => void run(async () => {
    if (Object.keys(patch).length) await api.mistakes.update(m.id, patch)
    if (m.landed) await landMistake(m.id)
    toast.success(t('mistakes.saved'))
  }).then((ok) => ok && setEditing(false))
  const practise = (): void => { void api.mistakes.replenish(m.id, true).catch((e) => toast.error(errText(e))); setPractising(true) }
  return <article className="min-w-0 rounded-2xl border border-border bg-surface shadow-card" data-testid="mistake-details">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <Button variant="ghost" size="sm" onClick={back} className="-ml-2 @min-[860px]:hidden"><ArrowLeft />{t('mistakes.back')}</Button>
      <span data-tint={TINT[m.subject]} className="tint rounded-md px-2 py-0.5 text-xs font-medium">{t(`mistakes.subjectNames.${m.subject}`)}</span>
      <span className="text-xs text-subtle">{new Date(m.createdAt).toLocaleDateString()}</span>
      <div className="ml-auto flex items-center gap-1.5">
        {!editing && <>
          <Button size="sm" variant="primary" disabled={!m.landed || processing || busy} title={!m.landed ? t('mistakes.landFirst') : undefined} onClick={practise}><Dumbbell />{t('mistakes.practice')}</Button>
          <Button size="sm" variant="outline" disabled={busy || processing} onClick={() => void run(async () => { const ids = await api.discover.remedy(m.id); toast.success(t('discover.remedyDone', { count: ids.length })) })}>{t('discover.remedyAction')}</Button>
          <Button size="sm" variant="outline" disabled={busy || processing} onClick={() => setEditing(true)}><Pencil />{t('mistakes.edit')}</Button>
          <Menu><MenuTrigger asChild><Button size="sm" variant="ghost" aria-label={t('mistakes.more')}><MoreHorizontal /></Button></MenuTrigger><MenuContent align="end">
            {m.noteId && <MenuItem onSelect={() => useApp.getState().openNote(m.noteId)}><NotebookText />{t('mistakes.openNote')}</MenuItem>}
            {retryable && <MenuItem onSelect={() => void run(() => api.mistakes.retry(m.id))}><RotateCcw />{t('mistakes.retry')}</MenuItem>}
            {(m.noteId || retryable) && <MenuSeparator />}
            <MenuItem danger onSelect={() => void run(async () => { await removeMistake(m.id); back(); toast.success(t('mistakes.removed')) })}><Trash2 />{t('mistakes.delete')}</MenuItem>
          </MenuContent></Menu>
        </>}
      </div>
    </header>

    <div className="space-y-6 px-5 py-5 @min-[600px]:px-7 @min-[600px]:py-6">
      {processing && <div className="rounded-xl bg-accent-soft p-3.5 text-sm text-accent"><div className="flex flex-wrap items-center gap-2"><Loader2 className="size-4 animate-spin" /><span className="flex-1">{t('mistakes.processing')}</span>{job && <Button size="sm" variant="ghost" onClick={() => void run(() => api.jobs.cancel(job.id))}>{t('mistakes.cancel')}</Button>}</div><progress className="mt-2.5 h-1 w-full accent-[var(--accent)]" aria-label={t('mistakes.progress')} max={1} value={job?.progress ?? 0} /></div>}
      {notices.map((f) => <p key={f} className="rounded-lg bg-sunken px-3.5 py-2.5 text-sm leading-relaxed text-muted">{t(`mistakes.${FLAG_KEY[f]}`)}</p>)}

      {editing ? <Editor m={m} busy={busy} save={save} cancel={() => setEditing(false)} /> : <>
        <Section label={t('mistakes.question')}>
          {m.question.trim() ? <RichMistake text={m.question} className="text-base leading-[1.8] text-fg" /> : <p className="text-sm text-subtle">{t('mistakes.noQuestion')}</p>}
          {m.imageUrl && <details className="group mt-3" open={!m.question.trim()}>
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-fg"><ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" />{t('mistakes.originalImage')}</summary>
            <a href={m.originalImageUrl ?? m.imageUrl} target="_blank" rel="noreferrer" className="mt-2 block w-fit rounded-lg border border-border bg-white p-2"><img src={m.imageUrl} alt={t('mistakes.image')} className="max-h-72 max-w-full object-contain" /></a>
          </details>}
        </Section>

        {m.myAnswer.trim() && <Section label={t('mistakes.myAnswer')} tone="wrong"><RichMistake text={m.myAnswer} className="text-[15px] text-fg" /></Section>}

        {(m.cause !== 'unknown' || m.causeReason) && <section className="rounded-xl border border-warning/25 bg-warning/[0.07] px-4 py-3.5" data-testid="mistake-cause">
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold tracking-wide text-warning">{t('mistakes.cause')}</span><span className="rounded-md bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">{t(`mistakes.causeNames.${m.cause}`)}</span></div>
          {m.causeReason && <RichMistake text={m.causeReason} className="mt-2 text-sm leading-relaxed text-fg" />}
        </section>}

        {(m.correctAnswer.trim() || m.solution.trim()) && <Section label={t('mistakes.correctAnswer')} tone="right" extra={unverified
          ? <span className="rounded-full bg-warning/12 px-2 py-0.5 text-2xs font-medium text-warning">{t('mistakes.unverified')}</span>
          : m.verified ? <span className="rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-medium text-accent">{t('mistakes.verified')}</span> : null}>
          {m.correctAnswer.trim() && <RichMistake text={m.correctAnswer} className="text-[15px] font-medium text-fg" />}
          {m.solution.trim() && (m.solution.length > 280 && m.correctAnswer.trim()
            ? <details className="group mt-3"><summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-fg"><ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" />{t('mistakes.solution')}</summary><RichMistake text={m.solution} className="mt-2 text-[15px] text-fg/85" /></details>
            : <RichMistake text={m.solution} className={cn('text-[15px] text-fg/85', m.correctAnswer.trim() && 'mt-3')} />)}
          {unverified && <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await api.mistakes.update(m.id, { verified: true }); if (m.landed) await landMistake(m.id); toast.success(t('mistakes.confirmed')) })}><Check />{t('mistakes.confirm')}</Button>}
        </Section>}

        {m.concepts.length > 0 && <Section label={t('mistakes.concepts')}><div className="flex flex-wrap gap-1.5">{m.concepts.map((c) => <span key={c} className="rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent">{c}</span>)}</div></Section>}

        <footer className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {m.landed
            ? <span className="inline-flex items-center gap-1.5 text-sm text-muted"><Check className="size-4 text-accent" />{t('mistakes.landed')}</span>
            : <Button variant="secondary" disabled={!m.question.trim() || busy || processing} onClick={() => void run(async () => { await landMistake(m.id); toast.success(t('mistakes.landed')) })}><NotebookText />{t('mistakes.land')}</Button>}
          {m.landed && m.noteId && <Button size="sm" variant="ghost" onClick={() => useApp.getState().openNote(m.noteId)}>{t('mistakes.openNote')}</Button>}
          {!m.landed && <span className="text-xs text-subtle">{t('mistakes.landFirst')}</span>}
        </footer>
      </>}
    </div>
    <MistakePracticeDialog id={m.id} open={practising} close={() => setPractising(false)} />
  </article>
}

function Item({ m, active, select }: { m: Mistake; active: boolean; select: () => void }) {
  const { t } = useTranslation()
  return <button className={cn('group relative flex w-full min-w-0 flex-col gap-2 overflow-hidden rounded-xl border py-3 pr-3.5 pl-5 text-left transition-colors', active ? 'border-accent/45 bg-accent-soft/50' : 'border-border bg-surface hover:border-border-strong hover:bg-surface-hover')} onClick={select} data-testid="mistake-item" data-mistake-id={m.id}>
    <span data-tint={TINT[m.subject]} className="tint-dot absolute inset-y-0 left-0 w-1 opacity-70" aria-hidden />
    {m.question.trim() ? <RichMistake text={m.question} plain className="line-clamp-3 text-sm leading-relaxed text-fg" />
      : m.imageUrl ? <img className="h-16 max-w-full self-start rounded-md bg-white object-contain" src={m.imageUrl} alt={t('mistakes.image')} />
        : <p className="text-sm text-subtle">{t('mistakes.noQuestion')}</p>}
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {m.flags.includes('processing')
        ? <span className="inline-flex items-center gap-1 text-accent"><Loader2 className="size-3 animate-spin" />{t('mistakes.processing')}</span>
        : <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-warning">{t(`mistakes.causeNames.${m.cause}`)}</span>}
      {m.concepts.slice(0, 2).map((c) => <span key={c} className="max-w-[10rem] truncate rounded-md bg-sunken px-1.5 py-0.5 text-muted">{c}</span>)}
      <span className="ml-auto shrink-0 text-subtle">{t(`mistakes.subjectNames.${m.subject}`)} · {new Date(m.createdAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span>
    </div>
  </button>
}

export function MistakesView() {
  const { t } = useTranslation(), qc = useQueryClient()
  const [filters, setFilters] = useState<NonNullable<MistakeFilters>>({}), [selected, setSelected] = useState<string | null>(null), [adding, setAdding] = useState(false), [more, setMore] = useState(false)
  const query = useQuery({ queryKey: ['mistakes', filters], queryFn: () => api.mistakes.list(filters) })
  const all = useQuery({ queryKey: ['mistakes', 'all-concepts'], queryFn: () => api.mistakes.list() })
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs.list(), refetchInterval: query.data?.some((m) => m.flags.includes('processing')) ? 1000 : false })
  const changed = (): void => { void qc.invalidateQueries({ queryKey: ['mistakes'] }); void qc.invalidateQueries({ queryKey: ['reviewStats'] }); void qc.invalidateQueries({ queryKey: ['notes'] }) }
  useEffect(() => {
    const a = window.jiweiEvents.on('mistakes:changed', () => { void qc.invalidateQueries({ queryKey: ['mistakes'] }) })
    const b = window.jiweiEvents.on('jobs:changed', () => { void qc.invalidateQueries({ queryKey: ['jobs'] }) })
    return () => { a(); b() }
  }, [qc])
  const m = query.data?.find((m) => m.id === selected) ?? null
  const concepts = [...new Set(all.data?.flatMap((m) => m.concepts) ?? [])]
  const subjects = MistakeSubjectSchema.options.filter((s) => all.data?.some((m) => m.subject === s))
  const extra = [filters.concept, filters.verified, filters.since, filters.until].filter((v) => v !== undefined).length
  const total = all.data?.length ?? 0
  const pill = (active: boolean): string => cn('h-8 shrink-0 rounded-full px-3.5 text-sm transition-colors', active ? 'bg-fg text-bg' : 'text-muted hover:bg-surface-hover hover:text-fg')

  return <div className="@container mx-auto w-full max-w-[1180px] min-w-0 px-5 pt-6 pb-16 @min-[700px]:px-8" data-testid="mistakes-view">
    <div className="mb-5 flex items-end gap-4">
      <div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><h2 className="font-serif text-xl font-semibold text-fg">{t('mistakes.title')}</h2>{total > 0 && <span className="text-sm text-subtle tabular-nums">{total}</span>}</div><p className="mt-1 text-sm text-muted">{t('mistakes.emptyHint')}</p></div>
      <Button variant="primary" onClick={() => setAdding(true)}><Plus />{t('mistakes.add')}</Button>
    </div>

    {total > 0 && <div className="mb-5 space-y-3" data-testid="mistake-filters">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t('mistakes.allSubjects')} className="flex flex-wrap items-center gap-0.5">
          <button role="radio" aria-checked={!filters.subject} className={pill(!filters.subject)} onClick={() => setFilters({ ...filters, subject: undefined })}>{t('mistakes.all')}</button>
          {subjects.map((s) => <button key={s} role="radio" aria-checked={filters.subject === s} className={pill(filters.subject === s)} onClick={() => setFilters({ ...filters, subject: s })}>{t(`mistakes.subjectNames.${s}`)}</button>)}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select aria-label={t('mistakes.allCauses')} className={selectStyle} value={filters.cause ?? ''} onChange={(e) => setFilters({ ...filters, cause: e.target.value ? MistakeCauseSchema.parse(e.target.value) : undefined })}><option value="">{t('mistakes.allCauses')}</option>{MistakeCauseSchema.options.map((s) => <option key={s} value={s}>{t(`mistakes.causeNames.${s}`)}</option>)}</select>
          <label className="relative"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" /><Input className="h-9 w-48 pl-8 text-sm" aria-label={t('mistakes.search')} placeholder={t('mistakes.search')} value={filters.search ?? ''} onChange={(e) => setFilters({ ...filters, search: e.target.value || undefined })} /></label>
          <Button variant={more || extra ? 'secondary' : 'ghost'} size="sm" className="h-9" onClick={() => setMore(!more)}><SlidersHorizontal />{t('mistakes.moreFilters')}{extra > 0 && <span className="tabular-nums">· {extra}</span>}</Button>
        </div>
      </div>
      {more && <div className="flex flex-wrap items-center gap-2 rounded-xl bg-sunken/70 p-2.5">
        <select aria-label={t('mistakes.allConcepts')} className={cn(selectStyle, 'max-w-52')} value={filters.concept ?? ''} onChange={(e) => setFilters({ ...filters, concept: e.target.value || undefined })}><option value="">{t('mistakes.allConcepts')}</option>{concepts.map((c) => <option key={c}>{c}</option>)}</select>
        <select aria-label={t('mistakes.allVerified')} className={selectStyle} value={filters.verified === undefined ? '' : String(filters.verified)} onChange={(e) => setFilters({ ...filters, verified: e.target.value ? e.target.value === 'true' : undefined })}><option value="">{t('mistakes.allVerified')}</option><option value="true">{t('mistakes.verified')}</option><option value="false">{t('mistakes.unverified')}</option></select>
        <label className="flex items-center gap-1.5 text-sm text-muted">{t('mistakes.fromDate')}<input type="date" aria-label={t('mistakes.fromDate')} className={cn(selectStyle, 'w-36')} onChange={(e) => setFilters({ ...filters, since: e.target.value ? new Date(`${e.target.value}T00:00:00`).getTime() : undefined })} /></label>
        <label className="flex items-center gap-1.5 text-sm text-muted">{t('mistakes.toDate')}<input type="date" aria-label={t('mistakes.toDate')} className={cn(selectStyle, 'w-36')} onChange={(e) => setFilters({ ...filters, until: e.target.value ? new Date(`${e.target.value}T23:59:59.999`).getTime() : undefined })} /></label>
      </div>}
    </div>}

    {total === 0 && !query.isLoading ? <div className="rounded-2xl border border-dashed border-border-strong px-6 py-16 text-center">
      <ImagePlus className="mx-auto size-10 text-subtle" strokeWidth={1.3} />
      <p className="mt-4 font-serif text-lg text-fg">{t('mistakes.empty')}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">{t('mistakes.emptyLong')}</p>
      <Button className="mt-5" variant="primary" onClick={() => setAdding(true)}><Plus />{t('mistakes.add')}</Button>
    </div> : <div className="grid min-w-0 grid-cols-1 items-start gap-5 @min-[860px]:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
      <div className={cn('min-w-0 space-y-2', m && 'hidden @min-[860px]:block')} data-testid="mistake-list">
        {query.data?.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">{t('mistakes.noMatch')}</p>}
        {query.data?.map((item) => <Item key={item.id} m={item} active={item.id === selected} select={() => setSelected(item.id)} />)}
      </div>
      {m ? <Detail key={`${m.id}:${m.updatedAt}`} m={m} back={() => setSelected(null)} changed={changed} job={jobs.data?.find((j) => j.key === `mistake-split:${m.id}` && (j.status === 'running' || j.status === 'queued'))} />
        : <div className="hidden min-h-64 place-items-center rounded-2xl border border-dashed border-border text-sm text-subtle @min-[860px]:grid">{t('mistakes.selectHint')}</div>}
    </div>}
    <AddDialog open={adding} close={() => setAdding(false)} added={(id) => { setSelected(id); changed() }} />
  </div>
}
