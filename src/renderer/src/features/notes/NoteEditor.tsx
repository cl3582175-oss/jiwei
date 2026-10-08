import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { Pin, MoreHorizontal, Trash2, Folder, Check, Inbox, ChevronDown, Circle } from 'lucide-react'
import type { DocJSON, Note, NoteUpdate } from '@shared/types'
import { useCategories, useNote, invalidate } from '@/lib/queries'
import { api, cn, formatRelative } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { RichEditor } from './RichEditor'

const SAVE_DELAY = 700

type Part = 'cue' | 'content' | 'summary'

function useAutosave(noteId: string) {
  const qc = useQueryClient()
  const pending = useRef<NoteUpdate>({})
  const timer = useRef<number | undefined>(undefined)
  const [status, setStatus] = useState<'saved' | 'saving'>('saved')
  const [wordCount, setWordCount] = useState<number | null>(null)

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    const patch = pending.current
    if (Object.keys(patch).length === 0) return
    pending.current = {}
    setStatus('saving')
    try {
      const summary = await api.notes.update(noteId, patch)
      setWordCount(summary.wordCount)
      invalidate(qc, 'notes', 'heatmap')
    } catch (e) {
      // 保存失败时把补丁放回队列，下次继续尝试
      pending.current = { ...patch, ...pending.current }
      toast.error(String(e))
    } finally {
      setStatus('saved')
    }
  }, [noteId, qc])

  const queue = useCallback(
    (patch: NoteUpdate) => {
      pending.current = { ...pending.current, ...patch }
      setStatus('saving')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY)
    },
    [flush]
  )

  // 切换笔记 / 关闭窗口时立即保存
  useEffect(() => {
    const onUnload = (): void => void flush()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      void flush()
    }
  }, [flush])

  return { queue, flush, status, wordCount }
}

function TitleInput({ initial, onChange, onEnter }: { initial: string; onChange: (v: string) => void; onEnter: () => void }) {
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
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onEnter()
        }
      }}
      className="w-full resize-none overflow-hidden bg-transparent font-serif text-xl leading-[1.45] font-semibold tracking-wide text-fg outline-none placeholder:text-subtle/70"
    />
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-2xs font-medium tracking-[0.18em] text-subtle uppercase">
      <Circle className="size-1.5 fill-accent text-accent" />
      {children}
    </div>
  )
}

function CategoryPicker({ note, onChange }: { note: Note; onChange: (id: string | null) => void }) {
  const { t } = useTranslation()
  const { data: cats = [] } = useCategories('note')
  const [current, setCurrent] = useState(note.categoryId)
  const name = cats.find((c) => c.id === current)?.name ?? t('common.uncategorized')
  const pick = (id: string | null): void => {
    setCurrent(id)
    onChange(id)
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-fg">
          {current ? <Folder className="size-3.5" /> : <Inbox className="size-3.5" />}
          <span className="max-w-[180px] truncate">{name}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        <MenuItem onSelect={() => pick(null)}>
          <Check className={cn(current !== null && 'invisible')} />
          {t('common.uncategorized')}
        </MenuItem>
        {cats.length > 0 && <MenuSeparator />}
        {cats.map((c) => (
          <MenuItem key={c.id} onSelect={() => pick(c.id)}>
            <Check className={cn(current !== c.id && 'invisible')} />
            {c.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

function EditorBody({ note }: { note: Note }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const openNote = useApp((s) => s.openNote)
  const { queue, flush, status, wordCount } = useAutosave(note.id)
  const [pinned, setPinned] = useState(note.pinned)
  const editors = useRef<Partial<Record<Part, Editor>>>({})

  const plainText = (): string =>
    (['cue', 'content', 'summary'] as Part[])
      .map((p) => editors.current[p]?.getText({ blockSeparator: '\n' }) ?? '')
      .filter(Boolean)
      .join('\n')

  const onPartChange = (part: Part) => (ed: Editor) => {
    editors.current[part] = ed
    queue({ [part]: ed.getJSON() as DocJSON, plainText: plainText() })
  }

  const togglePin = async (): Promise<void> => {
    const next = !pinned
    setPinned(next)
    await api.notes.update(note.id, { pinned: next })
    invalidate(qc, 'notes')
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({ title: t('notes.deleteTitle'), description: t('notes.deleteDesc'), confirmText: t('common.delete'), danger: true })
    if (!ok) return
    await flush()
    await api.notes.trash(note.id)
    invalidate(qc, 'notes', 'trash')
    openNote(null)
    toast(t('notes.deleted'))
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <header className="drag flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-border/70 pr-[calc(var(--tb-right)+12px)] pl-6">
        <CategoryPicker
          note={note}
          onChange={(id) => {
            void api.notes.update(note.id, { categoryId: id }).then(() => invalidate(qc, 'notes'))
          }}
        />
        <div className="no-drag flex items-center gap-1">
          <span className="mr-2 text-2xs text-subtle tabular-nums">
            {status === 'saving'
              ? t('common.saving')
              : `${t('common.words', { count: wordCount ?? note.wordCount })} · ${formatRelative(note.updatedAt, i18n.language)}`}
          </span>
          <Tip label={pinned ? t('notes.unpin') : t('notes.pin')} side="bottom">
            <Button variant="ghost" size="icon-sm" onClick={() => void togglePin()} aria-pressed={pinned}>
              <Pin className={cn(pinned && 'fill-accent text-accent')} />
            </Button>
          </Tip>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('common.more')}>
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem danger onSelect={() => void remove()}>
                <Trash2 />
                {t('common.delete')}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>

      {/* 康奈尔版面：线索 0.382 | 笔记 0.618，底部总结 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-[1120px] flex-col px-10 pt-10 pb-16">
          <TitleInput
            initial={note.title}
            onChange={(title) => queue({ title })}
            onEnter={() => {
              // 同步聚焦（Tiptap 的 focus 命令是异步的，快速输入会落到标题里）
              const ed = editors.current.content
              if (!ed) return
              ed.view.focus()
              ed.commands.setTextSelection(1)
            }}
          />
          <div className="mt-8 grid flex-1 grid-cols-[38.2fr_61.8fr] rounded-xl border border-border bg-surface shadow-card">
            <section className="min-h-[360px] border-r border-border px-6 py-6">
              <SectionLabel>{t('notes.cue')}</SectionLabel>
              <RichEditor
                initial={note.cue}
                placeholder={t('notes.cueHint')}
                className="prose-cue"
                onReady={(ed) => (editors.current.cue = ed)}
                onChange={onPartChange('cue')}
              />
            </section>
            <section className="min-h-[360px] px-8 py-6">
              <SectionLabel>{t('notes.content')}</SectionLabel>
              <RichEditor
                initial={note.content}
                placeholder={t('notes.contentHint')}
                onReady={(ed) => (editors.current.content = ed)}
                onChange={onPartChange('content')}
              />
            </section>
            <section className="col-span-2 border-t border-border bg-sunken/40 px-8 py-6">
              <SectionLabel>{t('notes.summary')}</SectionLabel>
              <RichEditor
                initial={note.summary}
                placeholder={t('notes.summaryHint')}
                onReady={(ed) => (editors.current.summary = ed)}
                onChange={onPartChange('summary')}
              />
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

export function NoteEditor({ noteId }: { noteId: string }) {
  const { data: note, isLoading } = useNote(noteId)
  if (isLoading || !note) return null
  return <EditorBody key={note.id} note={note} />
}
