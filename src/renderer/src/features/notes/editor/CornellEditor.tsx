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
import { CornellAddRowWidget, CornellKeymap, CornellRowTimes, CornellShortcuts, CORNELL, rowTimesKey } from './cornell'
import { FormatBar } from './FormatBar'
import { OriginAttribute, PROPOSAL_META } from './origin'
import { Embed } from './embeds/EmbedNode'
import './embeds/MindmapView'
import { MindmapDataSchema, toCornellRows } from '@shared/embeds/mindmap'
import { useApp } from '@/store/app'
import { Tip } from '@/components/ui/primitives'
import { Rows3 } from 'lucide-react'

const INTERNAL_LINK = /^jiwei:\/\/(note|source)\/([0-9a-f-]{36})/i

/** 思维导图 → 康奈尔行：插入到导图所在行之后，沿用导图的来源标记 */
function mindmapToRows(editor: Editor, entry: Y.Map<unknown>, getPos: () => number | undefined, originAttr: string | null): void {
  const data = MindmapDataSchema.safeParse((entry.get('data') as { toJSON(): unknown }).toJSON())
  const pos = getPos()
  if (!data.success || pos === undefined) return
  const { state, view } = editor
  const $pos = state.doc.resolve(pos)
  let after = state.doc.content.size - state.doc.lastChild!.nodeSize
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === CORNELL.row) {
      after = $pos.after(d)
      break
    }
  }
  // 子块继承来源：AI 生成的导图展开后仍是 AI 内容（直到用户修改）
  const withOrigin = (nodes: unknown[]): unknown[] =>
    originAttr ? nodes.map((n) => ({ ...(n as object), attrs: { ...((n as { attrs?: object }).attrs ?? {}), origin: originAttr } })) : nodes
  const rows = toCornellRows(data.data).map((r) =>
    state.schema.nodeFromJSON({
      type: CORNELL.row,
      attrs: { origin: originAttr },
      content: [
        { type: CORNELL.cue, content: withOrigin(r.cue) },
        { type: CORNELL.body, content: withOrigin(r.body) }
      ]
    })
  )
  const tr = state.tr.insert(after, rows)
  if (originAttr) tr.setMeta(PROPOSAL_META, true)
  view.dispatch(tr.scrollIntoView())
}

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
      CornellRowTimes,
      OriginAttribute,
      Embed.configure({
        ydoc,
        renderActions: ({ kind, entry, props }) =>
          kind === 'mindmap' && props.editor.isEditable ? (
            <Tip label={t('embeds.toRows')} side="top">
              <button
                className="embed-action"
                aria-label={t('embeds.toRows')}
                onClick={() => mindmapToRows(props.editor, entry, props.getPos, (props.node.attrs.origin as string | null) ?? null)}
              >
                <Rows3 className="size-3.5" />
              </button>
            </Tip>
          ) : null
      })
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
        // 内部链接：jiwei://note/<id> 在应用内打开
        handleClick: (_view, _pos, event) => {
          const a = (event.target as HTMLElement).closest('a')
          const m = a?.getAttribute('href') ? INTERNAL_LINK.exec(a.getAttribute('href')!) : null
          if (!m) return false
          event.preventDefault()
          if (m[1] === 'note') useApp.getState().openNote(m[2])
          else useApp.getState().openSource(m[2])
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

  // AI 引用跳转：定位并高亮段落
  const highlight = useApp((s) => s.highlight)
  useEffect(() => {
    if (!editor || highlight?.type !== 'block') return
    let found = -1
    editor.state.doc.descendants((node, pos) => {
      if (found >= 0) return false
      if (node.attrs.id === highlight.id) found = pos
      return true
    })
    if (found < 0) return
    const dom = editor.view.nodeDOM(found) as HTMLElement | null
    if (dom) {
      dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
      dom.classList.add('is-flash')
      setTimeout(() => dom.classList.remove('is-flash'), 2200)
    }
    useApp.getState().setHighlight(null)
  }, [editor, highlight])

  // 工作区上下文：光标所在块 / 行、选中文字（AI 请求时随附）
  useEffect(() => {
    if (!editor) return
    const update = (): void => {
      const { $from, from, to, empty } = editor.state.selection
      let blockId: string | null = null
      let rowId: string | null = null
      for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d)
        if (!blockId && typeof n.attrs.id === 'string' && n.type.name !== CORNELL.row) blockId = n.attrs.id
        if (n.type.name === CORNELL.row) rowId = (n.attrs.id as string) ?? null
      }
      useApp.getState().setContext({
        cursorBlockId: blockId,
        cursorRowId: rowId,
        noteSelection: empty ? null : editor.state.doc.textBetween(from, to, '\n').slice(0, 4000)
      })
    }
    editor.on('selectionUpdate', update)
    return () => {
      editor.off('selectionUpdate', update)
    }
  }, [editor])

  // 段落级时间戳：悬停每一行时显示最后修改时间
  const { data: blocks } = useQuery({ queryKey: ['blocks', noteId], queryFn: () => api.notes.blocks(noteId) })
  useEffect(() => {
    if (!editor || !blocks) return
    const fmt = new Intl.DateTimeFormat(i18n.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
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
