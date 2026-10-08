import type { AnyExtension } from '@tiptap/core'
import { idExtension, schemaExtensions, type SchemaLabels } from './extensions'
import { OriginAttribute } from './origin'
import { Embed } from './embeds/EmbedNode'

/** 只读预览（历史版本、提案预览）使用的扩展：与编辑器 schema 完全一致 */
export function previewExtensions(labels: SchemaLabels): AnyExtension[] {
  return [...schemaExtensions(labels), idExtension(), OriginAttribute, Embed]
}
