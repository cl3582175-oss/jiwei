import { useEditorState, type Editor } from '@tiptap/react'
import { useTranslation } from 'react-i18next'
import { Bold, Italic, Strikethrough, Code, Heading1, Heading2, List, ListOrdered, Quote } from 'lucide-react'
import { cn } from '@/lib/utils'

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
    <button
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
    </button>
  )
}

export function FormatBar({ editor }: { editor: Editor }) {
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
