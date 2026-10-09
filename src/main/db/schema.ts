import { sqliteTable, text, integer, real, blob, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core'

// 修改本文件后执行 `npm run db:generate` 生成迁移，应用启动时会自动迁移（迁移前自动备份）。
//
// 同步就绪约定（为将来多设备同步 / 多人协作预留）：
// - 主键一律使用 UUIDv7（时间有序、全局唯一），不使用自增 ID
// - 可同步的表都带 created_at / updated_at / deleted_at（墓碑）/ updated_by（设备 ID）
// - 笔记正文以 Yjs CRDT 状态存储，天然支持多端合并与协同编辑

const syncCols = {
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  updatedBy: text('updated_by')
}

export const LINK_ENDPOINTS = ['note', 'source', 'segment', 'insight', 'goal', 'review', 'action'] as const
export const LINK_RELATIONS = ['reference', 'related', 'supersedes', 'evidence', 'derived_from', 'contradicts', 'applied_in'] as const

/** 本机元数据：设备 ID、知识库 ID 等 */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['note', 'source'] }).notNull(),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...syncCols
  },
  (t) => [index('categories_parent_idx').on(t.parentId)]
)

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color'),
    ...syncCols
  },
  (t) => [uniqueIndex('tags_name_idx').on(t.name)]
)

/** 标签关联（笔记、资料通用） */
export const taggings = sqliteTable(
  'taggings',
  {
    tagId: text('tag_id').notNull(),
    entityType: text('entity_type', { enum: ['note', 'source'] }).notNull(),
    entityId: text('entity_id').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.tagId, t.entityType, t.entityId] }), index('taggings_entity_idx').on(t.entityType, t.entityId)]
)

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default(''),
    /** 笔记类型：每种类型有自己的文档结构 */
    kind: text('kind', { enum: ['cornell', 'review', 'reading', 'free'] })
      .notNull()
      .default('cornell'),
    categoryId: text('category_id'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** 学习日期：知识是什么时候学到的（可手动修改，默认等于创建时间） */
    learnedAt: integer('learned_at').notNull(),
    /** 知识状态：有效 / 已过时 / 存疑 */
    status: text('status', { enum: ['active', 'outdated', 'disputed'] })
      .notNull()
      .default('active'),
    /** 被哪篇笔记取代 */
    supersededBy: text('superseded_by'),
    /** 隐私：为 true 时永不发送给 AI */
    aiExcluded: integer('ai_excluded', { mode: 'boolean' }).notNull().default(false),
    /** 不复习：线索不再自动成为复习卡片 */
    reviewExcluded: integer('review_excluded', { mode: 'boolean' }).notNull().default(false),
    /** 文档格式版本，编辑器结构升级时用于迁移旧文档 */
    docVersion: integer('doc_version').notNull().default(1),
    // 以下为从 Yjs 文档派生的字段（检索、列表、统计用）
    plainText: text('plain_text').notNull().default(''),
    wordCount: integer('word_count').notNull().default(0),
    /** 其中 AI 生成且未经用户审阅的字数（不计入学习统计） */
    aiWordCount: integer('ai_word_count').notNull().default(0),
    /** 正文最后修改时间（区别于 updated_at：后者包含置顶、分类等元数据变化） */
    editedAt: integer('edited_at').notNull(),
    ...syncCols
  },
  (t) => [
    index('notes_category_idx').on(t.categoryId),
    index('notes_deleted_idx').on(t.deletedAt),
    index('notes_edited_idx').on(t.editedAt)
  ]
)

/** 笔记正文：压缩后的 Yjs 文档状态 */
export const noteDocs = sqliteTable('note_docs', {
  noteId: text('note_id').primaryKey(),
  state: blob('state', { mode: 'buffer' }).notNull(),
  updatedAt: integer('updated_at').notNull()
})

/** 尚未压缩的 Yjs 增量更新（追加写入，崩溃安全） */
export const noteUpdates = sqliteTable(
  'note_updates',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    noteId: text('note_id').notNull(),
    update: blob('update', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('note_updates_note_idx').on(t.noteId)]
)

/** 版本历史快照 */
export const noteRevisions = sqliteTable(
  'note_revisions',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    title: text('title').notNull(),
    state: blob('state', { mode: 'buffer' }).notNull(),
    wordCount: integer('word_count').notNull().default(0),
    reason: text('reason', { enum: ['auto', 'manual', 'restore'] }).notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('note_revisions_note_idx').on(t.noteId, t.createdAt)]
)

/**
 * 段落级内容块：RAG 分片、批注锚点、引用溯源、复习卡片的统一来源。
 * 由 Yjs 文档派生；id 为文档中节点的永久 ID。
 */
export const blocks = sqliteTable(
  'blocks',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    /** row = 康奈尔行（线索 + 笔记）；其余为段落级节点类型 */
    kind: text('kind').notNull(),
    section: text('section', { enum: ['row', 'cue', 'body', 'summary'] }).notNull(),
    rowId: text('row_id'),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    hash: text('hash').notNull(),
    /** 内容来源：用户亲手写 / AI 生成 / AI 生成后经用户审阅 */
    origin: text('origin', { enum: ['user', 'ai', 'ai_reviewed'] })
      .notNull()
      .default('user'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at')
  },
  (t) => [index('blocks_note_idx').on(t.noteId, t.position), index('blocks_row_idx').on(t.rowId)]
)

/** 内容寻址的素材仓库（图片、音视频、文档文件） */
export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(), // sha256
  mime: text('mime'),
  ext: text('ext').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at').notNull()
})

/** 笔记引用过的素材（只增不减，直到笔记被永久删除；保证历史版本里的图片不丢失） */
export const noteAssets = sqliteTable(
  'note_assets',
  {
    noteId: text('note_id').notNull(),
    assetId: text('asset_id').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.noteId, t.assetId] }), index('note_assets_asset_idx').on(t.assetId)]
)

export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    assetId: text('asset_id'),
    originalName: text('original_name'),
    url: text('url'),
    author: text('author'),
    /** 资料本身的发布日期（书籍出版、文章发布） */
    publishedAt: integer('published_at'),
    /** 获取日期（导入 / 收藏的时间） */
    accessedAt: integer('accessed_at').notNull(),
    categoryId: text('category_id'),
    aiExcluded: integer('ai_excluded', { mode: 'boolean' }).notNull().default(false),
    ...syncCols
  },
  (t) => [
    index('sources_category_idx').on(t.categoryId),
    index('sources_deleted_idx').on(t.deletedAt),
    index('sources_asset_idx').on(t.assetId)
  ]
)

/**
 * 关联：笔记 ↔ 笔记 / 资料 / 网址。
 * origin = doc 表示从正文中的链接派生；manual 表示手动建立（如“被取代”关系）。
 * 目标位置使用 W3C Web Annotation 选择器（JSON）。
 */
export const links = sqliteTable(
  'links',
  {
    id: text('id').primaryKey(),
    fromType: text('from_type', { enum: LINK_ENDPOINTS }).notNull(),
    fromId: text('from_id').notNull(),
    fromBlockId: text('from_block_id'),
    toType: text('to_type', { enum: [...LINK_ENDPOINTS, 'url'] }).notNull(),
    toId: text('to_id').notNull(),
    toSelector: text('to_selector'),
    relation: text('relation', { enum: LINK_RELATIONS }).notNull().default('reference'),
    origin: text('origin', { enum: ['doc', 'manual'] }).notNull(),
    ...syncCols
  },
  (t) => [index('links_from_idx').on(t.fromType, t.fromId), index('links_to_idx').on(t.toType, t.toId)]
)

/**
 * 批注：遵循 W3C Web Annotation 数据模型。
 * selector 示例：
 *   { type: 'TextQuoteSelector', exact, prefix, suffix }
 *   { type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value: 'page=12' }  // PDF
 *   { type: 'FragmentSelector', conformsTo: 'http://www.w3.org/TR/media-frags/', value: 't=95,120' } // 音视频
 *   { type: 'BlockSelector', blockId }  // 积微笔记段落
 */
export const annotations = sqliteTable(
  'annotations',
  {
    id: text('id').primaryKey(),
    targetType: text('target_type', { enum: ['note', 'source'] }).notNull(),
    targetId: text('target_id').notNull(),
    selector: text('selector').notNull(),
    motivation: text('motivation', { enum: ['highlighting', 'commenting', 'drawing', 'bookmarking', 'questioning'] }).notNull(),
    body: text('body'),
    color: text('color'),
    ...syncCols
  },
  (t) => [index('annotations_target_idx').on(t.targetType, t.targetId)]
)

/** 学习活动日志，驱动日历热力图 */
export const activity = sqliteTable(
  'activity',
  {
    date: text('date').notNull(),
    kind: text('kind').notNull(),
    count: integer('count').notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.date, t.kind] })]
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

/* ————————————————— 身份 ————————————————— */

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatarAssetId: text('avatar_asset_id'),
  ...syncCols
})

/** 设备：updated_by 记录设备 ID，通过本表对应到用户 */
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull()
})

/* ————————————————— 资料分段 ————————————————— */

/**
 * 资料片段：与笔记 blocks 对称，是批注、引用溯源、导图锚点、RAG 定位到资料内部的统一单位。
 * locator 使用 W3C 选择器 JSON，如 { type: 'FragmentSelector', value: 'page=12' } 或 { value: 't=95,120' }。
 */
export const sourceSegments = sqliteTable(
  'source_segments',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').notNull(), // paragraph | page | transcript | heading | caption …
    locator: text('locator').notNull(),
    text: text('text').notNull(),
    hash: text('hash').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [index('segments_source_idx').on(t.sourceId, t.ordinal)]
)

/* ————————————————— 学习闭环 ————————————————— */

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['active', 'achieved', 'paused', 'dropped'] })
    .notNull()
    .default('active'),
  targetAt: integer('target_at'),
  categoryId: text('category_id'),
  ...syncCols
})

/** 复盘会话；复盘正文是一篇 kind = review 的笔记 */
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id'),
    kind: text('kind', { enum: ['daily', 'weekly', 'monthly', 'quarterly', 'topic', 'practice', 'belief'] }).notNull(),
    periodStart: integer('period_start'),
    periodEnd: integer('period_end'),
    /** 复盘范围：分类 / 标签 / 目标 / 笔记集合（JSON） */
    scope: text('scope'),
    template: text('template').notNull().default('grai'),
    status: text('status', { enum: ['draft', 'done'] })
      .notNull()
      .default('draft'),
    completedAt: integer('completed_at'),
    ...syncCols
  },
  (t) => [index('reviews_period_idx').on(t.kind, t.periodStart)]
)

/** 洞见：认知的最小单位，会被修正、推翻、升级 */
export const insights = sqliteTable('insights', {
  id: text('id').primaryKey(),
  statement: text('statement').notNull(),
  confidence: text('confidence', { enum: ['hypothesis', 'believed', 'verified'] })
    .notNull()
    .default('hypothesis'),
  status: text('status', { enum: ['active', 'revised', 'refuted'] })
    .notNull()
    .default('active'),
  version: integer('version').notNull().default(1),
  reviewId: text('review_id'),
  ...syncCols
})

export const insightVersions = sqliteTable(
  'insight_versions',
  {
    id: text('id').primaryKey(),
    insightId: text('insight_id').notNull(),
    version: integer('version').notNull(),
    statement: text('statement').notNull(),
    confidence: text('confidence').notNull(),
    /** 为什么修改 */
    reason: text('reason'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('insight_versions_idx').on(t.insightId, t.version)]
)

export const actions = sqliteTable('actions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status', { enum: ['open', 'done', 'dropped'] })
    .notNull()
    .default('open'),
  dueAt: integer('due_at'),
  doneAt: integer('done_at'),
  reviewId: text('review_id'),
  goalId: text('goal_id'),
  ...syncCols
})

/** 复习卡片（FSRS）：问题来自线索段落 */
export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    /** 问题所在的块（通常是线索栏段落或整行） */
    blockId: text('block_id').notNull(),
    due: integer('due').notNull(),
    stability: real('stability').notNull().default(0),
    difficulty: real('difficulty').notNull().default(0),
    elapsedDays: integer('elapsed_days').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    state: integer('state').notNull().default(0),
    /** FSRS 学习 / 重学阶段的步数（ts-fsrs v5） */
    learningSteps: integer('learning_steps').notNull().default(0),
    lastReview: integer('last_review'),
    suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
    ...syncCols
  },
  (t) => [index('cards_due_idx').on(t.due), uniqueIndex('cards_block_idx').on(t.blockId)]
)

export const reviewLogs = sqliteTable(
  'review_logs',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id').notNull(),
    rating: integer('rating').notNull(),
    state: integer('state').notNull(),
    due: integer('due').notNull(),
    stability: real('stability').notNull(),
    difficulty: real('difficulty').notNull(),
    elapsedDays: integer('elapsed_days').notNull(),
    scheduledDays: integer('scheduled_days').notNull(),
    durationMs: integer('duration_ms'),
    reviewedAt: integer('reviewed_at').notNull()
  },
  (t) => [index('review_logs_card_idx').on(t.cardId, t.reviewedAt)]
)

/** 学习者画像：AI 了解“你”的依据，用户可查看、修改、清除 */
export const learnerMemories = sqliteTable('learner_memories', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['goal', 'level', 'preference', 'strength', 'weakness', 'fact'] }).notNull(),
  content: text('content').notNull(),
  source: text('source', { enum: ['user', 'ai'] }).notNull(),
  confidence: real('confidence'),
  ...syncCols
})

/* ————————————————— AI 与任务 ————————————————— */

/** AI 修改提案：一组以块 ID 定位的操作，用户逐条接受或拒绝 */
export const proposals = sqliteTable(
  'proposals',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    title: text('title').notNull(),
    ops: text('ops').notNull(),
    /** 每条操作的处理结果（JSON 数组：pending / accepted / rejected） */
    opStatus: text('op_status').notNull(),
    status: text('status', { enum: ['pending', 'resolved'] })
      .notNull()
      .default('pending'),
    model: text('model'),
    /** 依据的资料片段 / 笔记块（JSON） */
    sources: text('sources'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at')
  },
  (t) => [index('proposals_note_idx').on(t.noteId, t.status)]
)

/** 持久化后台任务：失败重试、重启续跑 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'canceled'] })
      .notNull()
      .default('queued'),
    progress: real('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    result: text('result'),
    runAfter: integer('run_after').notNull(),
    /** 去重键：同一键只保留一个未完成任务 */
    dedupeKey: text('dedupe_key'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [index('jobs_status_idx').on(t.status, t.runAfter), index('jobs_dedupe_idx').on(t.dedupeKey)]
)

/* ————————————————— AI 服务与对话 ————————————————— */

/** 模型服务商；API Key 用系统钥匙串（Electron safeStorage）加密后存储 */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKeyEnc: blob('api_key_enc', { mode: 'buffer' }),
  /** 可用模型列表（JSON 数组） */
  models: text('models').notNull().default('[]'),
  /** 是否在请求中发送思考强度参数（部分兼容接口不支持） */
  sendEffort: integer('send_effort', { mode: 'boolean' }).notNull().default(true),
  /** 用户对模型能力的设定（JSON：{ 模型名: { vision?, tier? } }），覆盖按名称的自动判断 */
  modelCaps: text('model_caps').notNull().default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...syncCols
})

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default(''),
    /** 检索范围（JSON）：全部知识库 / 指定笔记与资料 / 不使用知识库 */
    scope: text('scope').notNull().default('{"type":"all"}'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** 无痕：不使用、不形成记忆 */
    incognito: integer('incognito', { mode: 'boolean' }).notNull().default(false),
    /** chat 对话页；workspace 工作区面板；inline 选区就地提问 */
    kind: text('kind', { enum: ['chat', 'workspace', 'inline', 'feynman'] })
      .notNull()
      .default('chat'),
    /** 就地提问的锚点（JSON Anchor） */
    anchor: text('anchor'),
    /** 锚点所在的资料 / 笔记（用于在原文边缘显示标记） */
    anchorParentId: text('anchor_parent_id'),
    /** 费曼练习：概念、关联笔记 / 卡片、参考资料与诊断报告（JSON FeynmanMeta） */
    meta: text('meta'),
    ...syncCols
  },
  (t) => [index('conversations_updated_idx').on(t.updatedAt)]
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull().default(''),
    /** 模型的思考过程 */
    reasoning: text('reasoning'),
    /** 引用的知识库片段（JSON） */
    citations: text('citations'),
    /** 使用的技能与执行步骤（JSON AgentStep[]） */
    skill: text('skill'),
    steps: text('steps'),
    /** 发送时的工作区上下文（JSON） */
    context: text('context'),
    providerId: text('provider_id'),
    model: text('model'),
    effort: text('effort'),
    /** 用量（JSON：输入、输出、思考、缓存命中 token，估算费用） */
    usage: text('usage'),
    status: text('status', { enum: ['streaming', 'done', 'error', 'stopped'] })
      .notNull()
      .default('done'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)]
)

/**
 * 知识库检索分片：笔记行 / 总结段落 / 资料分段。
 * 整数主键与 vec_chunks 向量表的 rowid 一一对应（显式整数主键在 VACUUM 后不会改变）。
 */
export const chunks = sqliteTable(
  'chunks',
  {
    rowid: integer('rowid').primaryKey({ autoIncrement: true }),
    ownerType: text('owner_type', { enum: ['block', 'segment'] }).notNull(),
    ownerId: text('owner_id').notNull(),
    /** 所属笔记或资料 */
    parentType: text('parent_type', { enum: ['note', 'source'] }).notNull(),
    parentId: text('parent_id').notNull(),
    /** 参与向量化的文本哈希：内容不变不重复计算 */
    hash: text('hash').notNull(),
    /** 生成向量的模型；切换模型后据此重建 */
    model: text('model').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [uniqueIndex('chunks_owner_idx').on(t.ownerType, t.ownerId), index('chunks_parent_idx').on(t.parentType, t.parentId)]
)
