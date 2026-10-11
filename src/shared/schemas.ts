import { CaptureSettingsSchema } from './capture'
import { BudgetSchema, McpServeSettingsSchema } from './agent'
export { InboxCreateSchema, InboxUpdateSchema, InboxAcceptSchema } from './inbox'
import { z } from 'zod'
import { ExternalBackupSchema } from './backup'
import { DomainSchema, NetworkRuleSchema } from './browserSafety'
import { AnchorSchema, ContextPacketSchema } from './context'
import { RecordingFiltersSchema } from './lens'

// 所有跨进程输入的 zod 模式。类型由模式推导，保证“声明一次、处处一致”。

export const Id = z.string().min(1).max(64)
/** 二进制数据（Yjs 增量、文件字节） */
export const Bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array, { message: 'Expected Uint8Array' })
export const CategoryKindSchema = z.enum(['note', 'source'])
export const KnowledgeStatusSchema = z.enum(['active', 'outdated', 'disputed'])
export const NoteKindSchema = z.enum(['cornell', 'review', 'reading', 'free'])
export const NoteSortSchema = z.enum(['edited', 'created', 'learned', 'title'])
export const SourceKindSchema = z.enum(['book', 'pdf', 'video', 'audio', 'recording', 'image', 'document', 'web', 'other'])
export const TrashTypeSchema = z.enum(['note', 'source', 'category', 'recording'])
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
  aiExcluded: z.boolean().optional(),
  /** 不复习：线索不再成为复习卡片 */
  reviewExcluded: z.boolean().optional()
})
export type NoteMetaUpdate = z.infer<typeof NoteMetaUpdateSchema>

export const SourceQuerySchema = RecordingFiltersSchema.extend({
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
  recordingScene: z.enum(['meeting', 'lecture', 'thought']).optional(),
  capture: CaptureSettingsSchema.optional(),
  language: z.enum(['zh-CN', 'en']).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  palette: z.enum(['qinglu', 'celadon', 'dunhuang']).optional(),
  onboarded: z.boolean().optional(),
  sidebarCollapsed: z.boolean().optional(),
  ai: z.lazy(() => AiSettingsSchema).optional(),
  /** 费用上限（v0.7） */
  budget: z.lazy(() => BudgetSchema).optional(),
  /** 积微作为 MCP 服务端（v0.7） */
  mcpServe: z.lazy(() => McpServeSettingsSchema).optional(),
  reflection: z
    .object({
      daily: z.boolean(),
      weekly: z.boolean(),
      /** 0 = 周日 */
      weeklyDay: z.number().int().min(0).max(6),
      /** HH:mm */
      time: z.string().regex(/^\d{2}:\d{2}$/)
    })
    .optional(),
  review: z.object({ newPerDay: z.number().int().min(0).max(500), retention: z.number().min(0.8).max(0.97) }).optional(),
  /** 内置浏览器（v0.6.0）：搜索引擎、不发送给 AI 的网站、主动程度 */
  browser: z
    .object({
      networkRules: z.array(NetworkRuleSchema).max(500).optional(),
      externalSites: z.array(DomainSchema).max(500).optional(),
      searchEngine: z.string().url().max(300).optional(),
      aiBlockedSites: z.array(z.string().max(200)).max(500).optional(),
      proactivity: z.enum(['quiet', 'balanced', 'active']).optional(),
      course: z.object({ autoTimestamp: z.boolean(), autoSlides: z.boolean(), quiz: z.boolean() }).optional()
    })
    .optional(),
  backup: z.object({ external: ExternalBackupSchema }).optional()
})
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/* ——— 内容来源 ——— */

export const OriginSchema = z.object({
  proposalId: z.string().optional(),
  opIndex: z.number().optional(),
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
export const DocNodeSchema: z.ZodType<{ type: string; [k: string]: unknown }> = z
  .looseObject({ type: z.string() })
  .superRefine((node, ctx) => {
    const visit = (n: unknown, depth: number): void => {
      if (!n || typeof n !== 'object' || depth > 50) {
        ctx.addIssue({ code: 'custom', message: 'Invalid document node' })
        return
      }
      const value = n as { type?: string; attrs?: { latex?: unknown }; content?: unknown[] }
      if (
        (value.type === 'inlineMath' || value.type === 'blockMath') &&
        !z.string().trim().min(1).max(10000).safeParse(value.attrs?.latex).success
      )
        ctx.addIssue({ code: 'custom', message: 'Math nodes require LaTeX (1–10000 characters)' })
      if (Array.isArray(value.content)) value.content.forEach((c) => visit(c, depth + 1))
    }
    visit(node, 0)
  })

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
    mistakeId: Id.optional(),
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
  sources: OriginSchema.shape.sources,
  /** 用户主动操作产生的写入（如“存入笔记”）：笔记打开时直接应用，无需逐条确认 */
  auto: z.boolean().optional(),
  /** 生成时使用的技能（用于学习技能偏好） */
  skill: z.string().max(64).optional()
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
  enabled: z.boolean().optional(),
  /** 逐个模型改写能力（看图、强 / 普通）；某项不设表示按名称自动判断 */
  modelCaps: z
    .record(z.string().max(200), z.object({ vision: z.boolean().optional(), tier: z.enum(['basic', 'strong']).optional() }))
    .optional()
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
  incognito: z.boolean().optional(),
  /** 对话类型（仅新建时生效）：chat 对话页；workspace 工作区面板；inline 选区就地提问 */
  kind: z.enum(['chat', 'workspace', 'inline', 'feynman', 'reflection']).optional(),
  /** 复盘追问（仅新建时生效）：所属的复盘 */
  reflectionId: Id.optional(),
  /** 费曼练习（仅新建时生效）：要讲的概念、关联笔记 / 卡片 */
  feynman: z.object({ concept: z.string().min(1).max(200), noteId: Id.nullable().optional(), cardId: Id.nullable().optional() }).optional(),
  /** 就地提问的锚点（仅新建时生效） */
  anchor: AnchorSchema.optional(),
  /** 框选区域 / 视频画面（PNG data URL）；只发送给能看图的模型 */
  images: z.array(z.string().max(8_000_000).startsWith('data:image/')).max(4).optional()
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
  disabledSkills: z.array(z.string().max(64)).max(200).optional(),
  /** 视频 / 音频转写：本地（SenseVoice，离线）或云端（OpenAI 兼容 /audio/transcriptions） */
  transcription: z
    .object({ mode: z.enum(['local', 'cloud']), providerId: Id.nullable(), model: z.string().max(200).nullable() })
    .optional(),
  /**
   * 文档识别（扫描页、表格、图片资料）：本地（LightOnOCR，离线）、云端看图模型或关闭。
   * figures：解读插图（本地 LightOnOCR-3 给出简短描述；云端看图模型给出结构说明）
   */
  recognition: z
    .object({
      mode: z.enum(['local', 'cloud', 'off']),
      providerId: Id.nullable(),
      model: z.string().max(200).nullable(),
      auto: z.boolean(),
      figures: z.boolean(),
      /** 本地模型：fast = LightOnOCR-3-0.8B，accurate = LightOnOCR-3-4B */
      localModel: z.enum(['fast', 'accurate']).optional()
    })
    .optional()
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

export const MemorySettingsSchema = z.object({ autoLearn: z.boolean().optional(), learnSkills: z.boolean().optional() })

export const UserProfileSchema = z.object({
  role: z.string().max(500).optional(),
  goals: z.string().max(1000).optional(),
  background: z.string().max(1000).optional(),
  style: z.string().max(1000).optional(),
  avoid: z.string().max(1000).optional()
})

/** 「存入笔记」：把 AI 的回答（连同出处）写成笔记中的一行 */
export const SaveAnswerSchema = z.object({
  /** 目标笔记；null 时新建一篇（以资料名命名） */
  noteId: Id.nullable(),
  sourceId: Id.nullable().optional(),
  cue: z.string().max(500),
  answer: z.string().min(1).max(20000),
  anchor: AnchorSchema.optional(),
  model: z.string().max(200).optional()
})
export type SaveAnswer = z.infer<typeof SaveAnswerSchema>

/* ——— 复盘 ——— */

export const ReflectionKindSchema = z.enum(['daily', 'weekly', 'topic', 'practice', 'belief'])
export const ReflectionStartSchema = z.object({
  kind: ReflectionKindSchema,
  /** 专题复盘：主题、分类或标签 */
  topic: z.string().max(200).optional(),
  categoryId: Id.optional(),
  tagId: Id.optional()
})
export type ReflectionStart = z.infer<typeof ReflectionStartSchema>

export const InsightConfidenceSchema = z.enum(['hypothesis', 'believed', 'verified'])
export const HarvestCommitSchema = z.object({
  insights: z
    .array(
      z.object({ statement: z.string().min(1).max(500), confidence: InsightConfidenceSchema, evidence: z.string().max(500).optional() })
    )
    .max(20),
  revisions: z
    .array(
      z.object({ insightId: Id, statement: z.string().min(1).max(500), confidence: InsightConfidenceSchema, reason: z.string().max(500) })
    )
    .max(20),
  actions: z.array(z.object({ title: z.string().min(1).max(300), dueAt: z.number().int().nullable() })).max(20)
})
export type HarvestCommit = z.infer<typeof HarvestCommitSchema>

export const InsightUpdateSchema = z.object({
  statement: z.string().min(1).max(500).optional(),
  confidence: InsightConfidenceSchema.optional(),
  status: z.enum(['active', 'refuted']).optional(),
  /** 为什么改（记入版本历史） */
  reason: z.string().max(500).optional()
})

export const ActionUpdateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  status: z.enum(['open', 'done', 'dropped']).optional(),
  dueAt: z.number().int().nullable().optional()
})

/* ——— 学习目标 ——— */

export const GoalInputSchema = z.object({
  id: Id.optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'achieved', 'paused', 'dropped']).optional(),
  targetAt: z.number().int().nullable().optional(),
  categoryId: Id.nullable().optional(),
  noteIds: z.array(Id).max(500).optional()
})
export type GoalInput = z.infer<typeof GoalInputSchema>

/* ——— 批注（v0.5.3） ——— */

const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })

/** W3C Web Annotation 选择器（合并表示）：原文引用 + 片段 / 段落 + 页码与页内矩形 + 媒体时间段 */
export const AnnotationSelectorSchema = z.object({
  /** 资料片段 ID 或笔记段落 ID */
  ownerId: Id.nullable().optional(),
  quote: z.string().max(4000).optional(),
  prefix: z.string().max(200).optional(),
  suffix: z.string().max(200).optional(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
  page: z.number().int().min(1).optional(),
  /** 页内相对矩形（0–1），一段高亮可跨多行 */
  rects: z.array(RectSchema).max(200).optional(),
  t: z.tuple([z.number().min(0), z.number().min(0)]).optional()
})
export type AnnotationSelector = z.infer<typeof AnnotationSelectorSchema>

export const AnnotationMotivationSchema = z.enum(['highlighting', 'commenting', 'questioning', 'bookmarking', 'drawing'])
export const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'pink'] as const
export const AnnotationColorSchema = z.enum(ANNOTATION_COLORS)

export const AnnotationInputSchema = z.object({
  targetType: z.enum(['note', 'source']),
  targetId: Id,
  selector: AnnotationSelectorSchema,
  motivation: AnnotationMotivationSchema,
  body: z.string().max(20000).nullable().optional(),
  color: AnnotationColorSchema.nullable().optional()
})
export type AnnotationInput = z.infer<typeof AnnotationInputSchema>

export const AnnotationPatchSchema = z.object({
  body: z.string().max(20000).nullable().optional(),
  color: AnnotationColorSchema.nullable().optional(),
  motivation: AnnotationMotivationSchema.optional(),
  selector: AnnotationSelectorSchema.optional()
})
export type AnnotationPatch = z.infer<typeof AnnotationPatchSchema>

/* ——— 内置浏览器（v0.6.0） ——— */

export const BrowserRectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0) })

export const CourseOptionsSchema = z.object({
  mode: z.enum(['auto', 'local', 'off']).optional(),
  slides: z.boolean().optional(),
  quiz: z.boolean().optional()
})
const CourseTime = z.number().finite().min(0).max(604800)
const CourseEnvelope = z.object({ scope: Id, url: z.string().max(4000), media: Id })
export const CourseAbsentSchema = CourseEnvelope
/** 录音会话 ID：用作磁盘目录名，只允许字母、数字、下划线与连字符（防止路径穿越；来自网页进程的消息不可信） */
const CaptureId = z.string().regex(/^[\w-]{1,64}$/)
export const CourseAudioStartSchema = CourseEnvelope.extend({ capture: CaptureId })
export const CourseVideoSchema = CourseEnvelope.extend({
  currentTime: CourseTime,
  duration: CourseTime,
  paused: z.boolean(),
  rate: z.number().finite().positive().max(16),
  title: z
    .string()
    .max(10000)
    .transform((s) => s.slice(0, 300)),
  ended: z.boolean()
}).refine((v) => v.duration > 30 && v.currentTime <= v.duration + 5)
export const CourseCaptionsSchema = CourseEnvelope.extend({
  batch: z.number().int().min(0).max(200),
  done: z.boolean(),
  cues: z.array(z.object({ start: CourseTime, end: CourseTime, text: z.string().max(1000) }).refine((c) => c.end >= c.start)).max(500)
})
const boundedBuffer = (max: number) => z.custom<ArrayBuffer>((v) => v instanceof ArrayBuffer && v.byteLength > 0 && v.byteLength <= max)
export const CourseAudioSchema = CourseEnvelope.extend({
  capture: CaptureId,
  sequence: z.number().int().min(0).max(100000),
  start: CourseTime,
  end: CourseTime,
  rate: z.number().finite().positive().max(16),
  elapsed: z.number().finite().min(0).max(60),
  final: z.boolean(),
  bytes: boundedBuffer(2 * 1024 * 1024)
}).refine((v) => v.end >= v.start && v.end - v.start <= v.elapsed * v.rate + 3)
export const CourseFrameSchema = CourseEnvelope.extend({ t: CourseTime, jpeg: boundedBuffer(1.5 * 1024 * 1024), requestId: Id.optional() })
export const CourseErrorSchema = CourseEnvelope.extend({
  code: z.enum(['audio-blocked', 'frame-blocked', 'audio-unavailable']),
  requestId: Id.optional()
})
