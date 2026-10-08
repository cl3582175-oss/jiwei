import { useEffect, useMemo } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration'
import type { EditorView } from '@tiptap/pm/view'
import type * as Y from 'yjs'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { DOC_FIELD } from '@shared/types'
import { api, modKey } from '@/lib/utils'
import { idExtension, schemaExtensions } from './extensions'
import { CornellAddRowWidget, CornellKeymap, CornellRowTimes, CornellShortcuts, rowTimesKey } from './cornell'
import { FormatBar } from './FormatBar'

const IMAGE_MAX = 25 * 1024 * 1024

/** 把图片文件存入素材库并插入编辑器 */
async function insertImages(view: EditorView, files: File[], pos?: number): Promise<void> {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    if (f.size > IMAGE_MAX) {
      toast.error(`${f.name}: > 25 MB`)
      continue
    }
    const ref = await api.assets.importBytes(f.name || 'image', f.type, new Uint8Array(await f.arrayBuffer()))
    const node = view.state.schema.nodes.image.create({ src: ref.url, alt: f.name })
    const tr = pos !== undefined ? view.state.tr.insert(pos, node) : view.state.tr.replaceSelectionWith(node)
    view.dispatch(tr.scrollIntoView())
  }
}

function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type.startsWith('image/'))
}

interface Props {
  noteId: string
  ydoc: Y.Doc
  onReady?: (editor: Editor) => void
}

export function CornellEditor({ noteId, ydoc, onReady }: Props) {
  const { t, i18n } = useTranslation()

  const extensions = useMemo(
    () => [
      ...schemaExtensions({
        summary: t('notes.summary'),
        cueHint: t('notes.cueHint'),
        bodyHint: t('notes.contentHint'),
        summaryHint: t('notes.summaryHint')
      }),
      Collaboration.configure({ document: ydoc, field: DOC_FIELD }),
      // 远端（协同）事务不重新分配 ID，避免多端冲突
      idExtension((tr) => !isChangeOrigin(tr)),
      CornellKeymap,
      CornellShortcuts,
      CornellAddRowWidget.configure({ label: t('notes.addRow'), hint: `${modKey}↵` }),
      CornellRowTimes
    ],
    // 语言切换时重建编辑器以更新提示文字
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ydoc, i18n.language]
  )

  const editor = useEditor(
    {
      extensions,
      editorProps: {
        attributes: { class: 'prose-jiwei cornell-doc', spellcheck: 'false' },
        handlePaste: (view, event) => {
          const files = imageFiles(event.clipboardData?.files)
          if (files.length === 0) return false
          void insertImages(view, files)
          return true
        },
        handleDrop: (view, event) => {
          const files = imageFiles((event as DragEvent).dataTransfer?.files)
          if (files.length === 0) return false
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
          void insertImages(view, files, at?.pos)
          return true
        }
      }
    },
    [extensions]
  )

  useEffect(() => {
    if (editor) onReady?.(editor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // 段落级时间戳：悬停每一行时显示最后修改时间
  const { data: blocks } = useQuery({ queryKey: ['blocks', noteId], queryFn: () => api.notes.blocks(noteId) })
  useEffect(() => {
    if (!editor || !blocks) return
    const fmt = new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const times = new Map(blocks.filter((b) => b.section === 'row').map((b) => [b.id, fmt.format(b.updatedAt)]))
    editor.view.dispatch(editor.state.tr.setMeta(rowTimesKey, times).setMeta('addToHistory', false))
  }, [editor, blocks, i18n.language])

  if (!editor) return null
  return (
    <>
      <BubbleMenu editor={editor} options={{ placement: 'top', offset: 8 }}>
        <FormatBar editor={editor} />
      </BubbleMenu>
      <EditorContent editor={editor} />
    </>
  )
}
