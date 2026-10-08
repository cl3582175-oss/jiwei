import type { ComponentType } from 'react'
import type * as Y from 'yjs'

// 富内容块的界面注册表：每种 kind 提供显示 / 编辑组件。
// 数据层（转文字、校验）在 shared/embeds 中，主进程与渲染进程共用。

export interface EmbedViewProps {
  /** 该块在 Yjs embeds 映射中的数据（Y.Map：{ kind, data }） */
  entry: Y.Map<unknown>
  editable: boolean
  /** 块 ID */
  id: string
}

export interface EmbedUIDef {
  kind: string
  label: string
  View: ComponentType<EmbedViewProps>
}

export const embedViews: Record<string, EmbedUIDef> = {}

export function registerEmbedView(def: EmbedUIDef): void {
  embedViews[def.kind] = def
}
