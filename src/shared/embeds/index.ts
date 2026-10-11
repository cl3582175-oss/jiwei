import { toText as mindmapText, MindmapDataSchema } from './mindmap'
import {
  ChartDataSchema,
  chartText,
  DiagramDataSchema,
  diagramText,
  InteractiveDataSchema,
  interactiveText,
  StepsDataSchema,
  stepsText,
  TimelineDataSchema,
  timelineText
} from './visuals'
import { GraphDataSchema, checkGraph, graphText } from './graph'
import type { z } from 'zod'

const def = <T>(kind: string, schema: z.ZodType<T>, text: (d: T) => string): EmbedKindDef => ({
  kind,
  toText: (d) => {
    const r = schema.safeParse(d)
    return r.success ? text(r.data) : ''
  },
  validate: (d) => schema.safeParse(d).success
})

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
  },
  chart: def('chart', ChartDataSchema, chartText),
  diagram: def('diagram', DiagramDataSchema, diagramText),
  timeline: def('timeline', TimelineDataSchema, timelineText),
  steps: def('steps', StepsDataSchema, stepsText),
  interactive: def('interactive', InteractiveDataSchema, interactiveText),
  graph: {
    ...def('graph', GraphDataSchema, graphText),
    // 除结构外还要语义正确（表达式可解析、几何引用有效），否则 AI 或导入写入的图无法显示
    validate: (d) => {
      const r = GraphDataSchema.safeParse(d)
      return r.success && !checkGraph(r.data)
    }
  }
}

export function embedText(kind: string, data: unknown): string {
  return EMBED_KINDS[kind]?.toText(data) ?? ''
}
