import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import UniqueID from '@tiptap/extension-unique-id'
import type { AnyExtension } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { CornellBody, CornellCue, CornellDocument, CornellPlaceholder, CornellRow, CornellSummary, CORNELL } from './cornell'

/** 带永久 ID 的节点：段落级时间戳、批注锚点、RAG 分片都依赖它 */
export const ID_TYPES = [
  CORNELL.row,
  CORNELL.summary,
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'horizontalRule',
  'image'
]

export interface SchemaLabels {
  summary: string
  cueHint: string
  bodyHint: string
  summaryHint: string
}

/**
 * 文档结构相关的扩展（编辑器与只读预览共用，保证同一份 JSON 两边都能解析）。
 * 不含协同、ID 生成等运行时行为。
 */
export function schemaExtensions(labels: SchemaLabels): AnyExtension[] {
  return [
    StarterKit.configure({
      document: false,
      undoRedo: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true }
    }),
    CornellDocument,
    CornellRow,
    CornellCue,
    CornellBody,
    CornellSummary.configure({ label: labels.summary }),
    Image.configure({ inline: false, allowBase64: false }),
    CornellPlaceholder.configure({ cue: labels.cueHint, body: labels.bodyHint, summary: labels.summaryHint })
  ]
}

export function idExtension(filterTransaction: ((tr: Transaction) => boolean) | null = null): AnyExtension {
  return UniqueID.configure({ types: ID_TYPES, filterTransaction })
}
