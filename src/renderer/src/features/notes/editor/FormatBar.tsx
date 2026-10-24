import { Button } from '@/components/ui/shadcn-button'
import { useState } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { useTranslation } from 'react-i18next'
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Sparkles,
  ChevronDown,
  Lightbulb,
  PenLine,
  GraduationCap
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { askInline } from '@/features/assist/actions'
import { useAssist, REVISE_ACTIONS, type AskAction } from '@/features/assist/store'
import { noteSelectionTargets } from './aiSelection'
import { useApp } from '@/store/app'

function FormatButton({
  active,
  label,
  onClick,
  children
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button variant="ghost" size="auto"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'grid size-7 place-items-center rounded-md transition-colors [&_svg]:size-[15px]',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg'
      )}
    >
      {children}
    </Button>
  )
}

/** 选区 AI：修改（以行内差异提交，逐条确认）、解释、自定义指令。
 * 菜单渲染在浮条内部（不用弹出层），点击时编辑器不失焦，选区保持不变。 */
function AiMenu({ editor, noteId }: { editor: Editor; noteId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const run = (action: AskAction | 'custom' | 'feynman'): void => {
    setOpen(false)
    const sel = noteSelectionTargets(editor, noteId)
    if (!sel?.anchors.length) return
    if (action === 'feynman') {
      // 费曼练习：选中的文字作为要讲的概念（太长时取开头）
      const q = sel.quote.replace(/\s+/g, ' ').trim()
      useApp.getState().startFeynman({ concept: q.length > 40 ? q.slice(0, 40) + '…' : q, noteId })
      return
    }
    const [first, ...rest] = sel.anchors
    const primary = { ...first, quote: sel.quote.slice(0, 8000) }
    if (action === 'custom') {
      useAssist.getState().openCard({ anchor: primary, rect: sel.rect, action: 'revise', conversationId: null, question: '', extra: rest })
      return
    }
    void askInline(action, primary, sel.rect, undefined, undefined, rest)
  }
  const item =
    'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-fg hover:bg-surface-hover [&_svg]:size-3.5 [&_svg]:text-accent'
  return (
    <div className="relative">
      <Button variant="ghost" size="auto"
        aria-label={t('assist.aiMenu')}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-accent transition-colors hover:bg-accent-soft [&_svg]:size-3.5"
      >
        <Sparkles />
        AI
        <ChevronDown className={cn('!size-3 opacity-60 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={t('assist.aiMenu')}
          className="absolute top-full left-0 z-10 mt-2 w-44 rounded-lg border border-border bg-surface p-1 shadow-float"
        >
          {REVISE_ACTIONS.map((a) => (
            <Button variant="ghost" size="auto" key={a} role="menuitem" className={item} onMouseDown={(e) => e.preventDefault()} onClick={() => run(a)}>
              <PenLine />
              {t(`assist.actions.${a}`)}
            </Button>
          ))}
          <Button variant="ghost" size="auto" role="menuitem" className={item} onMouseDown={(e) => e.preventDefault()} onClick={() => run('custom')}>
            <Sparkles />
            {t('assist.actions.revise')}
          </Button>
          <div className="my-1 h-px bg-border" />
          <Button variant="ghost" size="auto" role="menuitem" className={item} onMouseDown={(e) => e.preventDefault()} onClick={() => run('explain')}>
            <Lightbulb />
            {t('assist.actions.explain')}
          </Button>
          <Button variant="ghost" size="auto" role="menuitem" className={item} onMouseDown={(e) => e.preventDefault()} onClick={() => run('feynman')}>
            <GraduationCap />
            {t('feynman.action')}
          </Button>
        </div>
      )}
    </div>
  )
}

export function FormatBar({ editor, noteId }: { editor: Editor; noteId?: string }) {
  const { t } = useTranslation()
  const c = (): ReturnType<Editor['chain']> => editor.chain().focus()
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote')
    })
  })
  const items = [
    { k: 'bold', icon: <Bold />, run: () => c().toggleBold().run(), active: on.bold },
    { k: 'italic', icon: <Italic />, run: () => c().toggleItalic().run(), active: on.italic },
    { k: 'strike', icon: <Strikethrough />, run: () => c().toggleStrike().run(), active: on.strike },
    { k: 'code', icon: <Code />, run: () => c().toggleCode().run(), active: on.code },
    null,
    { k: 'h1', icon: <Heading1 />, run: () => c().toggleHeading({ level: 2 }).run(), active: on.h2 },
    { k: 'h2', icon: <Heading2 />, run: () => c().toggleHeading({ level: 3 }).run(), active: on.h3 },
    { k: 'bullet', icon: <List />, run: () => c().toggleBulletList().run(), active: on.bullet },
    { k: 'ordered', icon: <ListOrdered />, run: () => c().toggleOrderedList().run(), active: on.ordered },
    { k: 'quote', icon: <Quote />, run: () => c().toggleBlockquote().run(), active: on.quote }
  ]
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-float">
      {noteId && editor.isEditable && (
        <>
          <AiMenu editor={editor} noteId={noteId} />
          <span className="mx-0.5 h-4 w-px bg-border" />
        </>
      )}
      {items.map((it, i) =>
        it ? (
          <FormatButton key={it.k} active={it.active} label={t(`editor.${it.k}`)} onClick={it.run}>
            {it.icon}
          </FormatButton>
        ) : (
          <span key={i} className="mx-0.5 h-4 w-px bg-border" />
        )
      )}
    </div>
  )
}
