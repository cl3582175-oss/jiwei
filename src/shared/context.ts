import { z } from 'zod'
import type { WorkspaceContext } from './types'

// 上下文包：用户“指”着的内容。界面自动生成，AI 据此理解“这个 / 这里 / 刚才”指什么。
// 设计见 docs/design/v0.3-agent.md §2。

const Id = z.string().min(1).max(64)

export const ProjectReaderSourceSchema = z.object({ projectId: Id, sourceId: Id })
export type ProjectReaderSource = z.infer<typeof ProjectReaderSourceSchema>

export const AnchorKindSchema = z.enum([
  /** 资料中选中的文字 */
  'source-text',
  /** 助手回复中选中的文字 */
  'text',
  /** 笔记中选中的文字 */
  'note-text',
  /** 笔记中的整块（段落、行、内容块） */
  'block',
  /** 视频 / 音频中的时间段 */
  'media-range',
  /** 资料中框选的区域（图、公式、视频画面） */
  'region',
  /** 当前可见的页或片段（用户没有选中时） */
  'viewport'
])

export const AnchorSchema = z.object({
  kind: AnchorKindSchema,
  parentType: z.enum(['note', 'source', 'message']),
  parentId: Id,
  /** 资料片段 ID 或笔记段落 ID */
  ownerId: Id.nullable().optional(),
  /** W3C TextQuote：原文与前后文，资料更新后用于重新定位 */
  quote: z.string().max(8000).optional(),
  prefix: z.string().max(400).optional(),
  suffix: z.string().max(400).optional(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
  page: z.number().int().min(1).optional(),
  /** 媒体时间段（秒） */
  t: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional()
})
export type Anchor = z.infer<typeof AnchorSchema>

export const ContextPacketSchema = z.object({
  targets: z.array(AnchorSchema).max(8),
  viewport: AnchorSchema.nullable().optional(),
  noteId: Id.nullable().optional(),
  sourceId: Id.nullable().optional(),
  cursorBlockId: Id.nullable().optional(),
  cursorRowId: Id.nullable().optional(),
  /** 用户在积微助手侧栏提问时所在的页面（v0.6.7）：「今日」、复习卡片、错题……由该页面整理成简短文字 */
  page: z
    .object({ title: z.string().max(60), text: z.string().max(4000) })
    .nullable()
    .optional()
})
export type ContextPacket = z.infer<typeof ContextPacketSchema>

/** 把 locator 字符串（page=12 / t=95,120）解析进锚点 */
export function locatorFields(locator: string | null | undefined): Pick<Anchor, 'page' | 't'> {
  if (!locator) return {}
  const page = locator.match(/page=(\d+)/)
  if (page) return { page: Number(page[1]) }
  const t = locator.match(/t=([\d.]+)(?:,([\d.]+))?/)
  if (t) return { t: [Number(t[1]), Number(t[2] ?? t[1])] }
  return {}
}

/** 工作区实时状态 → 上下文包 */
export function packetFromWorkspace(c: WorkspaceContext): ContextPacket {
  const targets: Anchor[] = []
  if (c.sourceId && c.sourceSelection)
    targets.push({
      kind: 'source-text',
      parentType: 'source',
      parentId: c.sourceId,
      ownerId: c.sourceSegmentId,
      quote: c.sourceSelection.slice(0, 8000),
      ...locatorFields(c.sourceLocator)
    })
  if (c.noteId && c.noteSelection)
    targets.push({
      kind: 'note-text',
      parentType: 'note',
      parentId: c.noteId,
      ownerId: c.cursorBlockId,
      quote: c.noteSelection.slice(0, 8000)
    })
  const viewport: Anchor | null =
    c.sourceId && !c.sourceSelection
      ? { kind: 'viewport', parentType: 'source', parentId: c.sourceId, ownerId: c.sourceSegmentId, ...locatorFields(c.sourceLocator) }
      : null
  return { targets, viewport, noteId: c.noteId, sourceId: c.sourceId, cursorBlockId: c.cursorBlockId, cursorRowId: c.cursorRowId }
}

/** 时间格式 95 → 1:35 */
export function fmtTime(sec: number): string {
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
