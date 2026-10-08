import { TableKit } from '@tiptap/extension-table'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import UniqueID from '@tiptap/extension-unique-id'
import type { AnyExtension } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { CornellBody, CornellCue, CornellDocument, CornellPlaceholder, CornellRow, CornellSummary } from './cornell'

export { ID_TYPES } from '@shared/docSchema'
import { ID_TYPES } from '@shared/docSchema'

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
      // 允许应用内链接 jiwei://note|source/<id>（否则会被当作不安全链接清空）
      link: { openOnClick: false, autolink: true, protocols: ['jiwei'] }
    }),
    // 表格（AI 生成表格、用户粘贴表格）
    TableKit.configure({ table: { resizable: false } }),
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
