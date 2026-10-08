import { z } from 'zod'

// 所有跨进程输入的 zod 模式。类型由模式推导，保证“声明一次、处处一致”。

export const Id = z.string().min(1).max(64)
/** 二进制数据（Yjs 增量、文件字节） */
export const Bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array, { message: 'Expected Uint8Array' })
export const CategoryKindSchema = z.enum(['note', 'source'])
export const KnowledgeStatusSchema = z.enum(['active', 'outdated', 'disputed'])
export const NoteKindSchema = z.enum(['cornell', 'review', 'reading', 'free'])
export const NoteSortSchema = z.enum(['edited', 'created', 'learned', 'title'])
export const SourceKindSchema = z.enum(['book', 'pdf', 'video', 'audio', 'image', 'document', 'web', 'other'])
export const TrashTypeSchema = z.enum(['note', 'source', 'category'])
export const EntityTypeSchema = z.enum(['note', 'source'])

export const NoteQuerySchema = z.object({
  categoryId: Id.nullable().optional().describe('分类 ID；null 表示未分类'),
  includeDescendants: z.boolean().optional().describe('是否包含子分类'),
  tagId: Id.optional(),
  pinnedOnly: z.boolean().optional(),
  status: KnowledgeStatusSchema.optional(),
  kind: NoteKindSchema.optional(),
  search: z.string().max(500).optional().describe('全文检索关键词'),
  sort: NoteSortSchema.optional(),
  limit: z.number().int().positive().max(1000).optional()
})
export type NoteQuery = z.infer<typeof NoteQuerySchema>

export const NoteInitSchema = z
  .object({ categoryId: Id.nullable().optional(), title: z.string().max(500).optional(), kind: NoteKindSchema.optional() })
  .optional()

export const NoteMetaUpdateSchema = z.object({
  title: z.string().max(500).optional(),
  categoryId: Id.nullable().optional(),
  pinned: z.boolean().optional(),
  learnedAt: z.number().int().optional(),
  status: KnowledgeStatusSchema.optional(),
  supersededBy: Id.nullable().optional(),
  aiExcluded: z.boolean().optional()
})
export type NoteMetaUpdate = z.infer<typeof NoteMetaUpdateSchema>

export const SourceQuerySchema = z.object({
  categoryId: Id.nullable().optional(),
  includeDescendants: z.boolean().optional(),
  kind: SourceKindSchema.optional(),
  tagId: Id.optional(),
  search: z.string().max(500).optional()
})
export type SourceQuery = z.infer<typeof SourceQuerySchema>

export const SourceUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  categoryId: Id.nullable().optional(),
  author: z.string().max(300).nullable().optional(),
  publishedAt: z.number().int().nullable().optional(),
  aiExcluded: z.boolean().optional()
})
export type SourceUpdate = z.infer<typeof SourceUpdateSchema>

export const CategoryPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  parentId: Id.nullable().optional(),
  color: z.string().max(32).nullable().optional()
})

export const SettingsPatchSchema = z.object({
  language: z.enum(['zh-CN', 'en']).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  palette: z.enum(['qinglu', 'celadon', 'dunhuang']).optional(),
  onboarded: z.boolean().optional(),
  reflection: z
    .object({
      daily: z.boolean(),
      weekly: z.boolean(),
      /** 0 = 周日 */
      weeklyDay: z.number().int().min(0).max(6),
      /** HH:mm */
      time: z.string().regex(/^\d{2}:\d{2}$/)
    })
    .optional()
})
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/* ——— 内容来源 ——— */

export const OriginSchema = z.object({
  by: z.literal('ai'),
  model: z.string().max(120).optional(),
  at: z.number().int(),
  /** 依据：资料片段 / 笔记块 */
  sources: z.array(z.object({ type: z.enum(['segment', 'block', 'source', 'note']), id: Id })).optional(),
  reviewed: z.boolean().optional()
})
export type Origin = z.infer<typeof OriginSchema>

/* ——— AI 修改提案 ——— */

/** ProseMirror 节点 JSON（宽松校验：结构由编辑器 schema 最终把关） */
export const DocNodeSchema: z.ZodType<{ type: string; [k: string]: unknown }> = z.looseObject({ type: z.string() })

/** 插入新的富内容块时随附的数据（以占位 ID 关联节点） */
export const EmbedPayloadSchema = z.object({ kind: z.string().max(40), data: z.unknown() })

export const ProposalOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert_after'),
    blockId: Id.describe('在此块之后插入；可以是行 ID 或段落 ID'),
    nodes: z.array(DocNodeSchema).min(1)
  }),
  z.object({
    op: z.literal('insert_row'),
    afterRowId: Id.nullable().describe('在此行之后插入新行；null 表示追加到末尾'),
    cue: z.array(DocNodeSchema),
    body: z.array(DocNodeSchema)
  }),
  z.object({ op: z.literal('append_summary'), nodes: z.array(DocNodeSchema).min(1) }),
  z.object({ op: z.literal('replace_block'), blockId: Id, nodes: z.array(DocNodeSchema).min(1) }),
  z.object({ op: z.literal('delete_block'), blockId: Id })
])
export type ProposalOp = z.infer<typeof ProposalOpSchema>

export const ProposalInputSchema = z.object({
  noteId: Id,
  title: z.string().min(1).max(200).describe('一句话说明这次修改，例如“根据第 3 章生成思维导图”'),
  ops: z.array(ProposalOpSchema).min(1).max(50),
  /** 新富内容块的数据，键为节点 attrs.id */
  embeds: z.record(z.string(), EmbedPayloadSchema).optional(),
  model: z.string().max(120).optional(),
  sources: OriginSchema.shape.sources
})
export type ProposalInput = z.infer<typeof ProposalInputSchema>
