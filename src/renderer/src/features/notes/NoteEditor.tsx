import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import {
  Pin,
  MoreHorizontal,
  Trash2,
  Folder,
  Check,
  Inbox,
  ChevronDown,
  History,
  ShieldOff,
  Shield,
  CircleCheck,
  CircleAlert,
  Archive,
  Replace,
  Home,
  CalendarDays,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  PanelLeftOpen,
  Sparkles,
  Download,
  Layers,
  Layers2 as LayersOff,
  Target,
  Network
} from 'lucide-react'
import type { KnowledgeStatus, NoteMetaUpdate, NoteSummary } from '@shared/types'
import { useCategories, useNote, invalidate } from '@/lib/queries'
import { api, cn, formatDate, formatDateTime, formatRelative, toDateInput, fromDateInput } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tip
} from '@/components/ui/primitives'
import { exportCurrentNote } from './exportNote'
import { confirm } from '@/components/ui/confirm'
import { CornellEditor } from './editor/CornellEditor'
import { useNoteDoc } from './editor/useNoteDoc'
import { TagEditor } from './TagEditor'
import { NotePicker } from './NotePicker'
import { HistoryDialog } from './HistoryDialog'
import { categoryPaths } from './CategoryTree'
import { ProposalPanel } from './ProposalPanel'
import { ConnectionsPanel } from './ConnectionsPanel'
import { CornellHelp } from './CornellHelp'
import { SaveSeal } from './SaveSeal'
import { SourcePicker } from '../workspace/SourcePicker'
import { modKey } from '@/lib/utils'

const TITLE_DELAY = 500

export const STATUS_META: Record<KnowledgeStatus, { icon: ReactNode; cls: string }> = {
  active: { icon: <CircleCheck />, cls: 'text-accent' },
  disputed: { icon: <CircleAlert />, cls: 'text-[#b8862b] dark:text-[#d9a74a]' },
  outdated: { icon: <Archive />, cls: 'text-subtle' }
}

function TitleInput({
  initial,
  onChange,
  onEnter,
  captureRef
}: {
  initial: string
  onChange: (v: string) => void
  onEnter: () => void
  /** 不为 null 时：输入不进入标题，而是按顺序缓冲（编辑器就绪后在正文中重放） */
  captureRef: React.RefObject<QueuedInput[] | null>
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLTextAreaElement>(null)
  const resize = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = el.scrollHeight + 'px'
  }
  useEffect(resize, [])
  return (
    <textarea
      ref={ref}
      rows={1}
      defaultValue={initial}
      autoFocus={!initial}
      placeholder={t('notes.titlePlaceholder')}
      onChange={(e) => {
        resize()
        onChange(e.target.value.replace(/\n/g, ' '))
      }}
      onBeforeInput={(e) => {
        if (captureRef.current === null) return
        e.preventDefault()
        const data = (e.nativeEvent as InputEvent).data
        if (data) captureRef.current.push({ text: data })
      }}
      onKeyDown={(e) => {
        const q = captureRef.current
        if (q !== null && !e.nativeEvent.isComposing) {
          // 可打印字符交给 beforeinput 记录；功能键（Tab、Enter、退格、方向键）与组合键在这里记录
          const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
          if (!printable) {
            e.preventDefault()
            q.push({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey })
          }
          return
        }
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onEnter()
        }
      }}
      className="w-full resize-none overflow-hidden bg-transparent font-serif text-xl leading-[1.45] font-semibold tracking-wide text-fg outline-none placeholder:text-subtle/70"
    />
  )
}

function CategoryPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useTranslation()
  const { data: cats = [] } = useCategories('note')
  const paths = categoryPaths(cats)
  const name = value ? (paths.get(value) ?? t('common.uncategorized')) : t('common.uncategorized')
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-fg">
          {value ? <Folder className="size-3.5" /> : <Inbox className="size-3.5" />}
          <span className="max-w-[260px] truncate">{name}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[60vh] overflow-y-auto">
        <MenuItem onSelect={() => onChange(null)}>
          <Check className={cn(value !== null && 'invisible')} />
          {t('common.uncategorized')}
        </MenuItem>
        {cats.length > 0 && <MenuSeparator />}
        {[...paths]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(([id, path]) => (
            <MenuItem key={id} onSelect={() => onChange(id)}>
              <Check className={cn(value !== id && 'invisible')} />
              {path}
            </MenuItem>
          ))}
      </MenuContent>
    </Menu>
  )
}

/** 学习日期：可修改（例如补记上周的课） */
function LearnedDate({ value, onChange }: { value: number; onChange: (ts: number) => void }) {
  const { t, i18n } = useTranslation()
  return (
    <Tip label={t('notes.learnedAtHint')} side="bottom">
      <label className="relative inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-fg">
        <CalendarDays className="size-3.5 text-subtle" />
        {t('notes.learnedOn', { date: formatDate(value, i18n.language) })}
        <input
          type="date"
          value={toDateInput(value)}
          max={toDateInput(Date.now())}
          onChange={(e) => e.target.value && onChange(fromDateInput(e.target.value, value))}
          className="absolute inset-0 cursor-pointer opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
        />
      </label>
    </Tip>
  )
}

/** 编辑器加载期间缓冲的输入 */
type QueuedInput = { text: string } | { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }

/** 在编辑器中按顺序重放缓冲的输入：文字直接插入，按键交给编辑器的快捷键处理 */
function replayInput(ed: Editor, queue: QueuedInput[]): void {
  for (const item of queue) {
    if ('text' in item) {
      ed.commands.insertContent(item.text)
      continue
    }
    const event = new KeyboardEvent('keydown', { ...item, bubbles: true, cancelable: true })
    const handled = ed.view.someProp('handleKeyDown', (f) => f(ed.view, event))
    if (!handled && item.key === 'Backspace')
      ed.commands.deleteRange({ from: Math.max(1, ed.state.selection.from - 1), to: ed.state.selection.from })
  }
}

/** 聚焦到第一行的笔记栏：行(0) → 线索 → 笔记 → 段落内。同步聚焦（Tiptap 的 focus 命令是异步的） */
function focusFirstBody(ed: Editor): void {
  const row = ed.state.doc.firstChild
  ed.view.focus()
  ed.commands.setTextSelection(row ? 3 + row.child(0).nodeSize : 1)
}

function EditorBody({ note: initial }: { note: NoteSummary }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { openNote, openSource, sourceId, back, forward, historyIndex, history } = useApp()
  const { ydoc, saving } = useNoteDoc(initial.id)
  const [note, setNote] = useState(initial)
  const editorRef = useRef<Editor | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  /** 标题回车时编辑器仍在加载：缓冲随后的输入，就绪后转入正文 */
  const pendingInput = useRef<QueuedInput[] | null>(null)
  const titleTimer = useRef<number | undefined>(undefined)
  const [historyOpen, setHistoryOpen] = useState(false)
  const { data: goals = [] } = useQuery({
    queryKey: ['goals', 'active'],
    queryFn: () => api.goals.list().then((l) => l.filter((g) => g.status === 'active'))
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const { data: superseder } = useNote(note.supersededBy)

  // 派生数据（字数、编辑时间）更新后刷新
  useEffect(() => {
    setNote((n) => ({ ...n, wordCount: initial.wordCount, aiWordCount: initial.aiWordCount, editedAt: initial.editedAt }))
  }, [initial.wordCount, initial.aiWordCount, initial.editedAt])

  const update = async (patch: NoteMetaUpdate): Promise<void> => {
    setNote((n) => ({ ...n, ...patch }) as NoteSummary)
    const next = await api.notes.update(note.id, patch)
    setNote((n) => ({ ...n, ...next, tagIds: n.tagIds }))
    invalidate(qc, 'notes', 'note')
  }

  // 标题：防抖保存；离开时立即保存
  const pendingTitle = useRef<string | null>(null)
  const flushTitle = (): void => {
    window.clearTimeout(titleTimer.current)
    if (pendingTitle.current !== null) {
      const title = pendingTitle.current
      pendingTitle.current = null
      void api.notes.update(note.id, { title }).then(() => invalidate(qc, 'notes', 'note'))
    }
  }
  useEffect(() => flushTitle, []) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('notes.deleteTitle'),
      description: t('notes.deleteDesc'),
      confirmText: t('common.delete'),
      danger: true
    })
    if (!ok) return
    flushTitle()
    await api.notes.trash(note.id)
    invalidate(qc, 'notes', 'trash')
    openNote(null)
    toast(t('notes.deleted'))
  }

  const saveVersion = async (): Promise<void> => {
    await api.revisions.create(note.id, 'manual')
    void qc.invalidateQueries({ queryKey: ['revisions', note.id] })
    toast.success(t('history.saved'))
  }

  return (
    <div className="@container flex h-full flex-col">
      {/* 顶栏 */}
      <header className="drag flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-border/70 pr-[calc(var(--tb-right)+12px)] pl-4">
        <div className="no-drag flex min-w-0 items-center gap-0.5">
          <Tip label={`${t('nav.back')}  ${modKey}[`} side="bottom">
            <Button variant="ghost" size="icon-sm" disabled={historyIndex <= 0} onClick={back} aria-label={t('nav.back')}>
              <ChevronLeft />
            </Button>
          </Tip>
          <Tip label={`${t('nav.forward')}  ${modKey}]`} side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={historyIndex >= history.length - 1}
              onClick={forward}
              aria-label={t('nav.forward')}
            >
              <ChevronRight />
            </Button>
          </Tip>
          <Tip label={t('nav.home')} side="bottom">
            <Button variant="ghost" size="icon-sm" onClick={() => openNote(null)} aria-label={t('nav.home')}>
              <Home />
            </Button>
          </Tip>
          <span className="mx-1 h-4 w-px bg-border" />
          <CategoryPicker value={note.categoryId} onChange={(categoryId) => void update({ categoryId })} />
        </div>
        <div className="no-drag flex items-center gap-1">
          <Tip label={`${t('notes.createdAt')} ${formatDateTime(note.createdAt, i18n.language)}`} side="bottom">
            <span className="mr-2 hidden cursor-default text-2xs whitespace-nowrap text-subtle tabular-nums @[560px]:inline">
              {saving
                ? t('common.saving')
                : `${t('common.words', { count: note.wordCount })} · ${t('notes.editedAgo', { time: formatRelative(note.editedAt, i18n.language) })}`}
              <SaveSeal saving={saving} />
            </span>
          </Tip>
          {note.aiExcluded && (
            <Tip label={t('notes.aiExcludedHint')} side="bottom">
              <span className="mr-1 inline-flex h-6 items-center gap-1 rounded-full bg-sunken px-2 text-2xs text-muted">
                <ShieldOff className="size-3" />
                {t('notes.aiExcluded')}
              </span>
            </Tip>
          )}
          {note.aiWordCount > 0 && (
            <Tip label={t('origin.aiWordsHint')} side="bottom">
              <span className="mr-1 hidden h-6 cursor-default items-center gap-1 rounded-full bg-accent-soft px-2 text-2xs whitespace-nowrap text-accent @[480px]:inline-flex">
                <Sparkles className="size-3" />
                {t('origin.aiWords', { count: note.aiWordCount })}
              </span>
            </Tip>
          )}
          {!sourceId && (
            <Tip label={t('workspace.openSource')} side="bottom">
              <Button variant="ghost" size="icon-sm" onClick={() => setSourcePickerOpen(true)} aria-label={t('workspace.openSource')}>
                <PanelLeftOpen />
              </Button>
            </Tip>
          )}
          {note.kind === 'cornell' && (
            <Tip label={t('graph.local')} side="bottom">
              <Button variant="ghost" size="icon-sm" onClick={() => useApp.getState().openGraph(`note:${note.id}`)} aria-label={t('graph.local')}>
                <Network />
              </Button>
            </Tip>
          )}
          <Tip label={t('history.title')} side="bottom">
            <Button variant="ghost" size="icon-sm" onClick={() => setHistoryOpen(true)} aria-label={t('history.title')}>
              <History />
            </Button>
          </Tip>
          <Tip label={note.pinned ? t('notes.unpin') : t('notes.pin')} side="bottom">
            <Button variant="ghost" size="icon-sm" onClick={() => void update({ pinned: !note.pinned })} aria-pressed={note.pinned}>
              <Pin className={cn(note.pinned && 'fill-accent text-accent')} />
            </Button>
          </Tip>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('common.more')}>
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent className="min-w-[220px]">
              <MenuLabel>{t('notes.status.label')}</MenuLabel>
              {(['active', 'disputed', 'outdated'] as KnowledgeStatus[]).map((s) => (
                <MenuItem key={s} onSelect={() => void update({ status: s, ...(s === 'active' ? { supersededBy: null } : {}) })}>
                  <span className={cn('[&_svg]:size-4', STATUS_META[s].cls)}>{STATUS_META[s].icon}</span>
                  <span className="flex-1">{t(`notes.status.${s}`)}</span>
                  {note.status === s && <Check />}
                </MenuItem>
              ))}
              <MenuItem onSelect={() => setPickerOpen(true)}>
                <Replace />
                {t('notes.supersede')}
              </MenuItem>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger>
                  <Download />
                  {t('export.title')}
                </MenuSubTrigger>
                <MenuSubContent>
                  {(['md', 'html', 'pdf', 'docx'] as const).map((f) => (
                    <MenuItem key={f} onSelect={() => void exportCurrentNote(note.id, f)}>
                      {t(`export.${f}`)}
                    </MenuItem>
                  ))}
                </MenuSubContent>
              </MenuSub>
              <MenuItem onSelect={() => void saveVersion()}>
                <Bookmark />
                {t('history.saveVersion')}
              </MenuItem>
              <MenuItem onSelect={() => void update({ aiExcluded: !note.aiExcluded })}>
                {note.aiExcluded ? <Shield /> : <ShieldOff />}
                {note.aiExcluded ? t('notes.aiInclude') : t('notes.aiExclude')}
              </MenuItem>
              {note.kind === 'cornell' && goals.length > 0 && (
                <MenuSub>
                  <MenuSubTrigger>
                    <Target />
                    {t('goals.linkNote')}
                  </MenuSubTrigger>
                  <MenuSubContent>
                    {goals.map((g) => {
                      const linked = g.noteIds.includes(note.id)
                      return (
                        <MenuItem
                          key={g.id}
                          onSelect={() =>
                            void api.goals.linkNote(g.id, note.id, !linked).then(() => qc.invalidateQueries({ queryKey: ['goals'] }))
                          }
                        >
                          {linked ? <Check /> : <span className="size-4" />}
                          {g.title}
                        </MenuItem>
                      )
                    })}
                  </MenuSubContent>
                </MenuSub>
              )}
              {note.kind === 'cornell' && (
                <MenuItem onSelect={() => void update({ reviewExcluded: !note.reviewExcluded })}>
                  {note.reviewExcluded ? <Layers /> : <LayersOff />}
                  {note.reviewExcluded ? t('notes.reviewInclude') : t('notes.reviewExclude')}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem danger onSelect={() => void remove()}>
                <Trash2 />
                {t('common.delete')}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1120px] animate-[rise-in_320ms_cubic-bezier(0.2,0.9,0.3,1)] px-10 pt-9 pb-24">
          {/* 已过时 / 被取代提示 */}
          {note.status !== 'active' && (
            <div
              className={cn(
                'mb-6 flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm',
                note.status === 'outdated' ? 'border-border bg-sunken text-muted' : 'border-[#b8862b]/30 bg-[#b8862b]/8 text-fg'
              )}
            >
              <span className={cn('[&_svg]:size-4', STATUS_META[note.status].cls)}>{STATUS_META[note.status].icon}</span>
              <span className="flex-1">
                {note.status === 'outdated' ? t('notes.outdatedBanner') : t('notes.disputedBanner')}
                {superseder && (
                  <>
                    {' '}
                    {t('notes.supersededBy')}
                    <button
                      onClick={() => openNote(superseder.id)}
                      className="mx-1 font-medium text-accent underline-offset-2 hover:underline"
                    >
                      《{superseder.title || t('common.untitled')}》
                    </button>
                  </>
                )}
              </span>
              <button onClick={() => void update({ status: 'active', supersededBy: null })} className="text-xs text-subtle hover:text-fg">
                {t('notes.markActive')}
              </button>
            </div>
          )}

          <ProposalPanel noteId={note.id} editor={editor} ydoc={ydoc} />

          <TitleInput
            initial={note.title}
            onChange={(title) => {
              pendingTitle.current = title
              window.clearTimeout(titleTimer.current)
              titleTimer.current = window.setTimeout(flushTitle, TITLE_DELAY)
            }}
            captureRef={pendingInput}
            onEnter={() => {
              const ed = editorRef.current
              if (ed) focusFirstBody(ed)
              else pendingInput.current = []
            }}
          />

          {/* 元信息：学习日期 · 标签 */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <LearnedDate value={note.learnedAt} onChange={(learnedAt) => void update({ learnedAt })} />
            <span className="h-3 w-px bg-border" />
            <TagEditor entityType="note" entityId={note.id} tagIds={note.tagIds} />
          </div>

          {/* 康奈尔版面：表头 + 文档（行 = 线索 0.382 | 笔记 0.618，底部总结） */}
          <div className="cornell-card mt-7">
            <div className="cornell-head">
              <span className="inline-flex items-center">
                {t('notes.cue')}
                <CornellHelp />
              </span>
              <span>{t('notes.content')}</span>
            </div>
            {ydoc ? (
              <CornellEditor
                noteId={note.id}
                ydoc={ydoc}
                onReady={(ed) => {
                  editorRef.current = ed
                  setEditor(ed)
                  if (pendingInput.current !== null) {
                    const queue = pendingInput.current
                    pendingInput.current = null
                    focusFirstBody(ed)
                    replayInput(ed, queue)
                  }
                }}
              />
            ) : (
              <div className="h-[360px]" />
            )}
          </div>
          <p className="mt-3 text-center text-2xs text-subtle">{t('notes.editorHint')}</p>
          {note.kind === 'cornell' && <ConnectionsPanel noteId={note.id} />}
        </div>
      </div>

      <HistoryDialog
        noteId={note.id}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestore={(doc) => editorRef.current?.commands.setContent(doc)}
      />
      <SourcePicker open={sourcePickerOpen} onOpenChange={setSourcePickerOpen} onPick={(id) => openSource(id)} />
      <NotePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t('notes.supersedePick')}
        excludeId={note.id}
        onPick={(supersededBy) => void update({ supersededBy, status: 'outdated' })}
      />
    </div>
  )
}

export function NoteEditor({ noteId }: { noteId: string }) {
  const { data: note, isLoading } = useNote(noteId)
  if (isLoading || !note) return null
  return <EditorBody key={note.id} note={note} />
}
