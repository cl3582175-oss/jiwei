import { useEffect } from 'react'
import { useEditor, useEditorState, EditorContent, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { useTranslation } from 'react-i18next'
import { Bold, Italic, Strikethrough, Code, Heading1, Heading2, List, ListOrdered, Quote } from 'lucide-react'
import type { DocJSON } from '@shared/types'
import { cn } from '@/lib/utils'

interface Props {
  initial: DocJSON
  placeholder: string
  className?: string
  onChange: (editor: Editor) => void
  onReady?: (editor: Editor) => void
}

function FormatButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
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

function FormatBar({ editor }: { editor: Editor }) {
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

export function RichEditor({ initial, placeholder, className, onChange, onReady }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true }
      }),
      Placeholder.configure({ placeholder })
    ],
    content: initial,
    editorProps: { attributes: { class: cn('prose-jiwei', className) } },
    onUpdate: ({ editor }) => onChange(editor)
  })

  useEffect(() => {
    if (editor) onReady?.(editor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  if (!editor) return null
  return (
    <>
      <BubbleMenu editor={editor} options={{ placement: 'top', offset: 8 }}>
        <FormatBar editor={editor} />
      </BubbleMenu>
      <EditorContent editor={editor} className="h-full" />
    </>
  )
}
