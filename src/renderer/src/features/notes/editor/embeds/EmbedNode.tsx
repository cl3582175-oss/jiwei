import { useEffect, useReducer } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import type * as Y from 'yjs'
import { useTranslation } from 'react-i18next'
import { Sparkles, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { embedViews } from './registry'
import { embedsMap } from './ydata'
import { parseOrigin } from '../origin'

// 富内容块节点：文档里只放占位节点（id、kind、origin），数据在 Yjs 的 embeds 映射中。

export interface EmbedOptions {
  ydoc: Y.Doc | null
  /** 每种块的额外操作（如思维导图“转为康奈尔行”） */
  renderActions?: (p: { kind: string; id: string; entry: Y.Map<unknown>; props: NodeViewProps }) => React.ReactNode
}

function EmbedView(props: NodeViewProps) {
  const { t } = useTranslation()
  const { node, extension, editor, selected } = props
  const { ydoc, renderActions } = extension.options as EmbedOptions
  const id = node.attrs.id as string
  const kind = node.attrs.kind as string
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const entry = ydoc ? (embedsMap(ydoc).get(id) as Y.Map<unknown> | undefined) : undefined

  useEffect(() => {
    if (!ydoc) return
    const map = embedsMap(ydoc)
    const onMap = (e: Y.YMapEvent<Y.Map<unknown>>): void => {
      if (e.keysChanged.has(id)) rerender()
    }
    map.observe(onMap)
    const current = map.get(id) as Y.Map<unknown> | undefined
    current?.observeDeep(rerender)
    return () => {
      map.unobserve(onMap)
      current?.unobserveDeep(rerender)
    }
  }, [ydoc, id, entry])

  const def = embedViews[kind]
  const origin = parseOrigin(node.attrs.origin)

  return (
    <NodeViewWrapper
      className={cn('embed-block group/embed', selected && 'is-selected')}
      data-kind={kind}
      data-embed-id={id}
      data-origin={origin ? (origin.reviewed ? 'ai-reviewed' : 'ai') : undefined}
    >
      <div className="embed-head" contentEditable={false}>
        <span className="embed-grip" data-drag-handle>
          <GripVertical className="size-3.5" />
        </span>
        <span className="embed-kind">{def ? t(def.label) : kind}</span>
        {origin?.by === 'ai' && (
          <span className="embed-ai" title={origin.model ?? undefined}>
            <Sparkles className="size-3" />
            {origin.reviewed ? t('origin.aiReviewed') : t('origin.ai')}
          </span>
        )}
        <span className="flex-1" />
        {entry && renderActions?.({ kind, id, entry, props })}
      </div>
      <div className="embed-body" contentEditable={false}>
        {def && entry ? (
          <def.View entry={entry} id={id} editable={editor.isEditable} />
        ) : (
          <div className="embed-missing">{t('embeds.missing')}</div>
        )}
      </div>
    </NodeViewWrapper>
  )
}

export const Embed = Node.create<EmbedOptions>({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ ydoc: null }),
  addAttributes: () => ({
    kind: { default: null, parseHTML: (el) => el.getAttribute('data-kind'), renderHTML: (a) => ({ 'data-kind': a.kind }) }
  }),
  parseHTML: () => [{ tag: 'div[data-embed]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-embed': '', class: 'embed-static' })],
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView)
  }
})
