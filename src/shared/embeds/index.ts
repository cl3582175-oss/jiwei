import { toText as mindmapText, MindmapDataSchema } from './mindmap'

// 富内容块注册表（纯数据层，主进程与渲染进程共用）。
// 渲染与编辑组件在 renderer/features/notes/editor/embeds 中按 kind 注册。

export interface EmbedKindDef {
  kind: string
  /** 把数据转为纯文本，供检索、RAG、字数统计 */
  toText(data: unknown): string
  /** 校验数据（AI 生成的数据必须通过） */
  validate(data: unknown): boolean
}

export const EMBED_KINDS: Record<string, EmbedKindDef> = {
  mindmap: {
    kind: 'mindmap',
    toText: (d) => {
      const r = MindmapDataSchema.safeParse(d)
      return r.success ? mindmapText(r.data) : ''
    },
    validate: (d) => MindmapDataSchema.safeParse(d).success
  }
}

export function embedText(kind: string, data: unknown): string {
  return EMBED_KINDS[kind]?.toText(data) ?? ''
}
