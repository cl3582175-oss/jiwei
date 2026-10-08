import { z } from 'zod'
import { ContextPacketSchema } from './context'

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
  sidebarCollapsed: z.boolean().optional(),
  ai: z.lazy(() => AiSettingsSchema).optional(),
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

/* ——— AI ——— */

export const ProviderKindSchema = z.enum(['deepseek', 'openai', 'anthropic', 'google', 'qwen', 'moonshot', 'zhipu', 'ollama', 'custom'])
export const EffortSchema = z.enum(['off', 'low', 'medium', 'high', 'max'])

export const ProviderInputSchema = z.object({
  id: Id.optional(),
  kind: ProviderKindSchema,
  name: z.string().max(80).optional(),
  baseUrl: z.string().max(500).optional(),
  /** 传空字符串表示清除；不传表示保持不变 */
  apiKey: z.string().max(500).optional(),
  models: z.array(z.string().max(200)).max(500).optional(),
  sendEffort: z.boolean().optional(),
  enabled: z.boolean().optional()
})
export type ProviderInput = z.infer<typeof ProviderInputSchema>

/** 对话的检索范围 */
export const ChatScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('items'), notes: z.array(Id).max(50), sources: z.array(Id).max(50) })
])
export type ChatScope = z.infer<typeof ChatScopeSchema>

export const ChatSendSchema = z.object({
  conversationId: Id.nullable(),
  text: z.string().min(1).max(20000),
  providerId: Id,
  model: z.string().min(1).max(200),
  effort: EffortSchema,
  scope: ChatScopeSchema,
  context: ContextPacketSchema.optional(),
  /** 由快捷操作直接指定的技能（省去路由） */
  skill: z.string().max(64).optional(),
  /** 无痕：不读取、不形成记忆（仅新建对话时生效） */
  incognito: z.boolean().optional()
})
export type ChatSend = z.infer<typeof ChatSendSchema>

export const AiSettingsSchema = z.object({
  chat: z.object({ providerId: Id.nullable(), model: z.string().max(200).nullable() }),
  effort: EffortSchema,
  embedding: z.object({
    mode: z.enum(['local', 'cloud']),
    providerId: Id.nullable(),
    model: z.string().max(200).nullable()
  }),
  /** 停用的技能名称 */
  disabledSkills: z.array(z.string().max(64)).max(200).optional()
})
export type AiSettings = z.infer<typeof AiSettingsSchema>

/* ——— 记忆 ——— */

export const MemoryKindSchema = z.enum(['profile', 'preference', 'fact', 'glossary', 'skill', 'episode', 'concept'])

export const MemoryInputSchema = z.object({
  id: Id.optional(),
  kind: MemoryKindSchema,
  key: z.string().max(64).optional(),
  skill: z.string().max(64).optional(),
  content: z.string().min(1).max(2000),
  sensitive: z.boolean().optional(),
  pinned: z.boolean().optional(),
  status: z.enum(['active', 'pending', 'archived']).optional()
})
export type MemoryInput = z.infer<typeof MemoryInputSchema>

export const MemoryQuerySchema = z.object({
  kind: MemoryKindSchema.optional(),
  status: z.enum(['active', 'pending', 'archived']).optional(),
  search: z.string().max(200).optional()
})
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>

export const UserProfileSchema = z.object({
  role: z.string().max(500).optional(),
  goals: z.string().max(1000).optional(),
  background: z.string().max(1000).optional(),
  style: z.string().max(1000).optional(),
  avoid: z.string().max(1000).optional()
})
