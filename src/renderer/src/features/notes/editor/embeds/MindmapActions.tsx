import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type * as Y from 'yjs'
import type { NodeViewProps } from '@tiptap/react'
import { Rows3, Pencil, Sparkles } from 'lucide-react'
import { embedText } from '@shared/embeds'
import { Tip } from '@/components/ui/primitives'
import { useAssist, elementRect } from '@/features/assist/store'
import { mindmapToRows } from './mindmapRows'
import { MindmapEditorDialog } from './MindmapEditor'

// 思维导图块的操作：编辑（mind-elixir）、AI 修改（以提案形式替换整张图）、展开为康奈尔行。

export function MindmapActions({ entry, props, noteId }: { entry: Y.Map<unknown>; props: NodeViewProps; noteId: string }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const id = props.node.attrs.id as string
  const aiEdit = (e: React.MouseEvent): void => {
    const data = (entry.get('data') as { toJSON(): unknown } | undefined)?.toJSON?.()
    useAssist.getState().openCard({
      anchor: { kind: 'block', parentType: 'note', parentId: noteId, ownerId: id, quote: embedText('mindmap', data).slice(0, 4000) },
      rect: elementRect(e.currentTarget),
      action: 'remap',
      conversationId: null,
      question: ''
    })
  }
  return (
    <>
      <Tip label={t('embeds.aiEdit')} side="top">
        <button className="embed-action" aria-label={t('embeds.aiEdit')} onClick={aiEdit}>
          <Sparkles className="size-3.5" />
        </button>
      </Tip>
      <Tip label={t('embeds.edit')} side="top">
        <button className="embed-action" aria-label={t('embeds.edit')} onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
        </button>
      </Tip>
      <Tip label={t('embeds.toRows')} side="top">
        <button
          className="embed-action"
          aria-label={t('embeds.toRows')}
          onClick={() => mindmapToRows(props.editor, entry, props.getPos, (props.node.attrs.origin as string | null) ?? null)}
        >
          <Rows3 className="size-3.5" />
        </button>
      </Tip>
      {editing && <MindmapEditorDialog entry={entry} open={editing} onOpenChange={setEditing} />}
    </>
  )
}
