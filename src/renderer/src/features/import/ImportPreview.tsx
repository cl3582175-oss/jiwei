import { useEffect, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import * as Y from 'yjs'
import { useTranslation } from 'react-i18next'
import { previewExtensions } from '../notes/editor/preview'
import { Embed } from '../notes/editor/embeds/EmbedNode'
import { writeEmbed } from '../notes/editor/embeds/ydata'
import '../notes/editor/embeds/VisualViews'
import type { ImportPreview as Preview } from '@shared/importer'

export function ImportPreview({ value }: { value: Preview }) {
  const { t } = useTranslation()
  const ydoc = useMemo(() => {
    const d = new Y.Doc()
    for (const [id, embed] of Object.entries(value.embeds)) writeEmbed(d, id, embed.kind, embed.data)
    return d
  }, [value])
  useEffect(() => () => ydoc.destroy(), [ydoc])
  const extensions = useMemo(
    () =>
      previewExtensions({ summary: t('notes.summary'), cueHint: '', bodyHint: '', summaryHint: '' }).map((e) =>
        e.name === 'embed' ? Embed.configure({ ydoc }) : e.name === 'image' ? e.configure({ allowBase64: true }) : e
      ),
    [t, ydoc]
  )
  const editor = useEditor(
    {
      extensions,
      content: value.doc,
      editable: false,
      editorProps: {
        attributes: { class: 'cornell-editor prose-jiwei' },
        handleClick: (_view, _pos, event) => {
          event.preventDefault()
          return true
        }
      }
    },
    [value, extensions]
  )
  return (
    <div data-testid="import-preview" className="min-w-0 overflow-x-auto rounded-lg border border-border bg-surface p-3">
      <EditorContent editor={editor} />
    </div>
  )
}
