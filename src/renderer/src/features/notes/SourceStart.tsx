import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useState } from 'react'
import { NotebookPen, Sparkles, NotebookText, BookOpen, Hash, MessageSquareText } from 'lucide-react'
import { api, formatRelative } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { useAssist } from '../assist/store'
import { errText } from '../chat/useChat'

// 资料的记笔记起始页（v0.7.6）：从资料库等处打开资料时，右边不再沿用上次打开的笔记，
// 而是为这份资料新建笔记、让 AI 起草提纲（先问范围），或接着写已关联的笔记。

export function SourceStart({ sourceId }: { sourceId: string }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: source } = useQuery({ queryKey: ['source', sourceId], queryFn: () => api.sources.get(sourceId) })
  const { data: notes = [] } = useQuery({
    queryKey: ['source', sourceId, 'notes'],
    queryFn: () => api.sources.notes(sourceId),
    staleTime: 0
  })
  const create = async (): Promise<void> => {
    try {
      const n = await api.notes.create({ title: source ? t('workspace.start.noteTitle', { title: source.title }) : '' })
      await api.connections.relate(n.id, 'source', sourceId)
      void qc.invalidateQueries({ queryKey: ['notes'] })
      useApp.getState().openNote(n.id)
    } catch (e) {
      toast.error(errText(e))
    }
  }
  // 起草前先在这里选范围（v0.7.6）：整份资料、某一章，或自己在对话里说
  const [picking, setPicking] = useState(false)
  const { data: outline = [] } = useQuery({
    queryKey: ['source', sourceId, 'outline'],
    queryFn: () => api.sources.outline(sourceId),
    enabled: picking
  })
  const { data: index } = useQuery({
    queryKey: ['source', sourceId, 'index'],
    queryFn: () => api.sources.indexStatus(sourceId),
    enabled: picking
  })
  // 去掉开头的文档总标题，只列章节
  const chapters = outline.length > 2 && outline[0].ordinal <= 1 ? outline.slice(1) : outline
  const ask = (text: string, auto: boolean): void => {
    setPicking(false)
    // 钉在右侧：资料 | 起始页（之后是新笔记）| 助手，三栏对照，不盖住内容
    useAssist.getState().setPanel({ panelOpen: true, panelPinned: true, panelConversationId: null, panelDraft: text, panelAutoSend: auto })
  }
  const title = source?.title ?? ''
  const chapterPrompt = (i: number): string => {
    const c = chapters[i]
    const next = chapters[i + 1]
    const pages = c.page && next?.page ? t('workspace.start.pages', { from: c.page, to: Math.max(c.page, next.page - 1) }) : ''
    return t('workspace.start.chapterPrompt', { title, chapter: c.title, pages })
  }
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-10 py-12" data-testid="source-start">
      <div className="w-full max-w-[440px]">
        <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent">
          <NotebookPen className="size-5" />
        </span>
        <h2 className="mt-4 font-serif text-xl font-semibold text-fg">{t('workspace.start.heading')}</h2>
        <p className="mt-1.5 line-clamp-2 text-sm text-muted">{t('workspace.start.sub', { title: source?.title ?? '' })}</p>
        <div className="mt-6 grid gap-2.5">
          <Button variant="primary" className="h-10 justify-start" onClick={() => void create()}>
            <NotebookPen />
            {t('workspace.start.blank')}
          </Button>
          <Button
            variant="outline"
            className="h-10 justify-start"
            onClick={() => setPicking(!picking)}
            aria-expanded={picking}
            disabled={!!source?.aiExcluded}
          >
            <Sparkles />
            {t('workspace.start.draft')}
          </Button>
        </div>
        {picking ? (
          <div className="mt-2 rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-1)]" data-testid="draft-scope">
            <p className="px-2 pt-1 pb-1.5 text-2xs text-subtle">{t('workspace.start.scope')}</p>
            <button
              onClick={() => ask(t('workspace.start.wholePrompt', { title }), true)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg hover:bg-surface-hover"
            >
              <BookOpen className="size-4 shrink-0 text-accent" />
              <span className="flex-1">{t('workspace.start.whole')}</span>
              {index && <span className="text-2xs text-subtle">{t('workspace.start.segments', { count: index.segments })}</span>}
            </button>
            {chapters.length > 1 && (
              <div className="max-h-56 overflow-y-auto">
                {chapters.map((c, i) => (
                  <button
                    key={c.ordinal}
                    onClick={() => ask(chapterPrompt(i), true)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-fg hover:bg-surface-hover"
                  >
                    <Hash className="size-3.5 shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {c.page && <span className="shrink-0 text-2xs text-subtle">p.{c.page}</span>}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => ask(t('workspace.start.freePrompt', { title }), false)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-muted hover:bg-surface-hover hover:text-fg"
            >
              <MessageSquareText className="size-4 shrink-0 text-subtle" />
              {t('workspace.start.free')}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-2xs leading-relaxed text-subtle">{t('workspace.start.draftHint')}</p>
        )}
        {notes.length > 0 && (
          <section className="mt-8">
            <h3 className="text-xs font-medium text-muted">{t('workspace.start.continue')}</h3>
            <ul className="mt-2 space-y-0.5" data-testid="source-start-notes">
              {notes.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => useApp.getState().openNote(n.id)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-hover"
                  >
                    <NotebookText className="size-4 shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1 truncate text-fg">{n.title || t('common.untitled')}</span>
                    <span className="shrink-0 text-2xs text-subtle">{formatRelative(n.updatedAt, i18n.language)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
