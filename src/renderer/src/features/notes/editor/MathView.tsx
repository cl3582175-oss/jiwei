import { Button } from '@/components/ui/shadcn-button'
import { Input } from '@/components/ui/input'
import { InputRule } from '@tiptap/core'
import { useState } from 'react'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import katex from 'katex'
import { useTranslation } from 'react-i18next'
import 'katex/dist/katex.min.css'

function MathView({ node, editor, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [latex, setLatex] = useState('')
  const block = node.type.name === 'blockMath'
  const value = String(node.attrs.latex ?? '')
  return (
    <NodeViewWrapper
      as={block ? 'div' : 'span'}
      className={block ? 'math-block' : 'math-inline'}
      data-type={block ? 'block-math' : 'inline-math'}
      data-latex={value}
      data-id={node.attrs.id}
      contentEditable={false}
    >
      {editing ? (
        <span className="inline-flex max-w-full flex-wrap items-center gap-1 rounded border border-border bg-paper p-1">
          <Input
            aria-label={t('captureContent.latex')}
            value={latex}
            maxLength={10000}
            autoFocus
            className="min-w-0 max-w-full rounded bg-sunken px-2 font-mono text-sm"
            onChange={(e) => setLatex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
              if (e.key === 'Enter' && latex.trim()) {
                updateAttributes({ latex: latex.trim() })
                setEditing(false)
                editor.commands.focus()
              }
            }}
          />
          <Button variant="ghost" size="auto"
            type="button"
            disabled={!latex.trim()}
            onClick={() => {
              updateAttributes({ latex: latex.trim() })
              setEditing(false)
              editor.commands.focus()
            }}
          >
            {t('captureContent.save')}
          </Button>
          <Button variant="ghost" size="auto" type="button" onClick={() => setEditing(false)}>
            {t('captureContent.cancel')}
          </Button>
        </span>
      ) : (
        <span
          role={editor.isEditable ? 'button' : undefined}
          tabIndex={editor.isEditable ? 0 : undefined}
          aria-label={t('captureContent.editFormula')}
          onClick={() => {
            if (editor.isEditable) {
              setLatex(value)
              setEditing(true)
            }
          }}
          onKeyDown={(e) => {
            if (editor.isEditable && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              setLatex(value)
              setEditing(true)
            }
          }}
          dangerouslySetInnerHTML={{
            __html: katex.renderToString(value, { displayMode: block, throwOnError: false, trust: false, maxExpand: 1000 })
          }}
        />
      )}
    </NodeViewWrapper>
  )
}

export const EditableInlineMath = InlineMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /(?<![\\$])\$((?:\\.|[^$\n])+)\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1].trim() }))
        }
      })
    ]
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathView, { as: 'span' })
  }
})
export const EditableBlockMath = BlockMath.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathView)
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from)
          // 输入规则只匹配光标之前的文字；已有后文时只替换匹配区，让 ProseMirror 保留后文段落。
          const wholeParagraph = range.from === $from.start() && range.to === $from.end()
          const canReplaceParagraph =
            $from.parent.isTextblock && $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)
          const from = wholeParagraph && canReplaceParagraph ? $from.before() : range.from
          const to = wholeParagraph && canReplaceParagraph ? $from.after() : range.to
          state.tr.replaceWith(from, to, this.type.create({ latex: match[1].trim() }))
        }
      })
    ]
  }
})
