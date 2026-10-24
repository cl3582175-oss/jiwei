import { Button } from '@/components/ui/shadcn-button'
import { useState } from 'react'
import Image, { type ImageOptions } from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/utils'

function ImageView({ node, editor, selected, extension }: NodeViewProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const noteId = (extension.options as { noteId?: string }).noteId
  const recognize = async (): Promise<void> => {
    const id = node.attrs.id as string | undefined
    const src = node.attrs.src
    if (!id || !noteId || busy) return
    setBusy(true)
    try {
      const result = await api.recognition.formula(noteId, id)
      if (!result) {
        toast.info(t('captureContent.noRecognition'))
        return
      }
      const formulas = result.blocks.filter((b) => b.label === 'formula').map((b) => b.text)
      const latex = (formulas.length ? formulas : [result.text])
        .map((s) =>
          s
            .trim()
            .replace(/^\$\$?\s*|\s*\$\$?$/g, '')
            .replace(/^\\\[|\\\]$/g, '')
            .trim()
        )
        .filter(Boolean)
      if (editor.isDestroyed) return
      let at: number | null = null
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'image' && n.attrs.id === id && n.attrs.src === src) at = pos + n.nodeSize
      })
      if (at !== null)
        editor
          .chain()
          .focus()
          .insertContentAt(
            at,
            latex.map((l) => ({ type: 'blockMath', attrs: { latex: l.slice(0, 10000) } }))
          )
          .run()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <NodeViewWrapper className="group/image relative max-w-full overflow-hidden" data-image-block={node.attrs.id} data-id={node.attrs.id}>
      <img
        src={node.attrs.src as string}
        alt={(node.attrs.alt as string) ?? ''}
        title={node.attrs.title as string | undefined}
        className={selected ? 'ProseMirror-selectednode' : ''}
      />
      {editor.isEditable && noteId && (
        <Button variant="ghost" size="auto"
          type="button"
          contentEditable={false}
          className="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-1rem)] rounded bg-secondary bg-paper px-2 py-1 text-xs shadow opacity-0 group-hover/image:pointer-events-auto group-hover/image:opacity-100 focus:pointer-events-auto focus:opacity-100"
          style={selected || busy ? { opacity: 1, pointerEvents: 'auto' } : undefined}
          disabled={busy}
          onClick={() => void recognize()}
        >
          {t(busy ? 'captureContent.recognizing' : 'captureContent.recognizeFormula')}
        </Button>
      )}
    </NodeViewWrapper>
  )
}
export const NoteImage = Image.extend<{ noteId?: string } & ImageOptions>({
  addOptions() {
    return { ...this.parent!(), noteId: undefined }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  }
})
