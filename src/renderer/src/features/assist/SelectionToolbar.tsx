import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightbulb, BookOpenText, Languages, MessageCircleQuestion, Highlighter, MessageSquarePlus, CircleHelp } from 'lucide-react'
import { useAssist, type AskAction } from './store'
import { askInline } from './actions'
import { annotate, lastColor } from '../annotate/store'
import { SWATCH } from '../annotate/AnnotationCard'
import { isForeignText } from '@shared/reading'

// 选区浮条：选中资料中的文字后出现在选区上方——解释 / 讲明白 / 翻译 / 问 AI；
// 以及批注：高亮、批注（写评论）、存疑。

const ACTIONS: { id: AskAction; icon: React.ReactNode }[] = [
  { id: 'explain', icon: <Lightbulb /> },
  { id: 'clarify', icon: <BookOpenText /> },
  { id: 'translate', icon: <Languages /> },
  { id: 'ask', icon: <MessageCircleQuestion /> }
]

export function SelectionToolbar() {
  const { t } = useTranslation()
  const toolbar = useAssist((s) => s.toolbar)
  const ref = useRef<HTMLDivElement>(null)

  // 点在别处、滚动、Esc：收起
  useEffect(() => {
    if (!toolbar) return
    const hide = (): void => useAssist.getState().showToolbar(null)
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) hide()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('scroll', hide, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [toolbar])

  if (!toolbar) return null
  const { rect, anchor } = toolbar
  const grammar=isForeignText(anchor.quote ?? '',document.documentElement.lang || 'zh-CN')
  const W = Math.min(grammar?540:470,window.innerWidth-24)
  const left = Math.min(Math.max(12, rect.x + rect.w / 2 - W / 2), window.innerWidth - W - 12)
  const above = rect.y > 56
  const top = above ? rect.y - 44 : rect.y + rect.h + 8

  const run = (a: AskAction): void => {
    if (a === 'ask') useAssist.getState().openCard({ anchor, rect, action: 'ask', conversationId: null, question: '' })
    else void askInline(a, anchor, rect)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('assist.toolbar')}
      style={{ left, top, width: W }}
      className="glass fixed z-50 flex items-center justify-center gap-0.5 rounded-xl border border-border p-1 shadow-float animate-[fade-in_120ms_ease-out]"
    >
      {[...ACTIONS,...(grammar?[{id:'grammar' as const,icon:<BookOpenText />}]:[])].map((a) => (
        <button
          key={a.id}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(a.id)}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-1 text-xs text-fg transition-colors hover:bg-surface-hover [&_svg]:size-3.5 [&_svg]:text-accent"
        >
          {a.icon}
          {a.id==='grammar'?t('reading.grammar'):t(`assist.actions.${a.id}`)}
        </button>
      ))}
      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
      {(
        [
          { m: 'highlighting', icon: <Highlighter />, label: 'annotate.highlight' },
          { m: 'commenting', icon: <MessageSquarePlus />, label: 'annotate.comment' },
          { m: 'questioning', icon: <CircleHelp />, label: 'annotate.question' }
        ] as const
      ).map((x) => (
        <button
          key={x.m}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            useAssist.getState().showToolbar(null)
            void annotate(anchor, x.m, rect, toolbar.rects)
          }}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-fg transition-colors hover:bg-surface-hover [&_svg]:size-3.5 [&_svg]:text-accent"
        >
          {x.m === 'highlighting' ? (
            <span className="relative">
              {x.icon}
              <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full" style={{ background: SWATCH[lastColor()] }} />
            </span>
          ) : (
            x.icon
          )}
          {t(x.label)}
        </button>
      ))}
    </div>
  )
}
