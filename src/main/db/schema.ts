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
export const LINK_RELATIONS = [
  'reference',
  'related',
  'supersedes',
  'evidence',
  'derived_from',
  'contradicts',
  'applied_in',
  // v0.14.2 知识图谱关系
  'prerequisite',
  'part_of',
  'contrasts'
] as const

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
    ...syncCols,
    /** 用户自己的 AI 排除选择；aiExcluded 保留为生效排除值。 */
    userAiExcluded: integer('user_ai_excluded', { mode: 'boolean' }).notNull().default(false)
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

/** 本地 OCR 缓存，不参加同步；可由同一内容寻址图片复用。 */
export const assetTexts = sqliteTable('asset_texts', {
  assetId: text('asset_id').primaryKey(),
  text: text('text').notNull(),
  engine: text('engine').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/** 当前正文中的图片定位；与历史素材保留表分离，删除图片立即移除此关联。 */
export const noteAssetBlocks = sqliteTable(
  'note_asset_blocks',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    assetId: text('asset_id').notNull(),
    blockId: text('block_id').notNull()
  },
  (t) => [index('note_asset_blocks_note_idx').on(t.noteId), index('note_asset_blocks_asset_idx').on(t.assetId)]
)

export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    webOrigin: text('web_origin', { mode: 'json' }).$type<import('@shared/retrieval').WebOrigin>(),
    assetId: text('asset_id'),
    originalName: text('original_name'),
    space: text('space', { enum: ['library', 'attachment'] })
      .notNull()
      .default('library'),
    parseVersion: integer('parse_version').notNull().default(0),
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
    origin: text('origin', { enum: ['doc', 'manual', 'ai'] }).notNull(),
    /** v0.14.2：AI 推断的关系先是 suggested，用户确认后 confirmed；否决为 rejected（以后不再提） */
    status: text('status', { enum: ['confirmed', 'suggested', 'rejected'] })
      .notNull()
      .default('confirmed'),
    /** 关系的一句理由与依据原句（AI 建议时填写） */
    reason: text('reason'),
    quote: text('quote'),
    confidence: real('confidence'),
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

/**
 * 学习活动记录层（v0.6.7）：每条是一次有效学习（读、听、写、复习、录音、练习……）。
 * 时长只统计窗口在前台且最近 60 秒有操作或正在播放的时间。今日、计划、洞察、复盘都从这里取数。
 */
export const activityEvents = sqliteTable(
  'activity_events',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    date: text('date').notNull(),
    kind: text('kind').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    durationMs: integer('duration_ms').notNull().default(0),
    count: integer('count').notNull().default(1)
  },
  (t) => [index('activity_events_date_idx').on(t.date, t.kind)]
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
    heading: text('heading').notNull().default(''),
    hash: text('hash').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [index('segments_source_idx').on(t.sourceId, t.ordinal)]
)

export const segmentAliases = sqliteTable(
  'segment_aliases',
  {
    oldId: text('old_id').primaryKey(),
    newId: text('new_id').notNull(),
    sourceId: text('source_id').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('segment_aliases_source_idx').on(t.sourceId)]
)

/**
 * 需要识别的页（v0.5.2 文档识别）：扫描页、表格页、图页。
 * 解析时写入待识别的页；识别结果缓存在这里，重新解析资料时不必重算，再并入 source_segments。
 */
export const sourcePages = sqliteTable(
  'source_pages',
  {
    sourceId: text('source_id').notNull(),
    page: integer('page').notNull(),
    need: text('need', { enum: ['scan', 'table', 'figure'] }).notNull(),
    status: text('status', { enum: ['pending', 'done', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
    /** 识别所用引擎：local:<模型> / cloud:<服务商>/<模型> */
    engine: text('engine'),
    text: text('text'),
    /** 版面块（LightOnOCR-3 grounding）：类型、坐标（0–1000）、内容，JSON；用于扫描页文字层 */
    blocks: text('blocks'),
    error: text('error'),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.page, t.need] })]
)

/* ————————————————— 学习闭环 ————————————————— */

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['exam', 'skill', 'project', 'interest'] })
    .notNull()
    .default('skill'),
  startAt: integer('start_at'),
  weeklyMinutes: integer('weekly_minutes'),
  weekdayMinutes: text('weekday_minutes'),
  color: text('color'),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['active', 'achieved', 'paused', 'dropped'] })
    .notNull()
    .default('active'),
  targetAt: integer('target_at'),
  categoryId: text('category_id'),
  ...syncCols
})

/** 创作工坊（v0.9）：作品与它的素材。正文按章节 / 页存在 content（WorkParts JSON） */
export const works = sqliteTable(
  'works',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['article', 'slides', 'video'] }).notNull(),
    title: text('title').notNull().default(''),
    topic: text('topic').notNull().default(''),
    audience: text('audience').notNull().default(''),
    mode: text('mode', { enum: ['coach', 'cowrite', 'ghost'] })
      .notNull()
      .default('cowrite'),
    stage: text('stage', { enum: ['topic', 'materials', 'outline', 'draft', 'polish', 'done'] })
      .notNull()
      .default('topic'),
    goalId: text('goal_id'),
    content: text('content'),
    template: text('template'),
    polish: text('polish'),
    exports: text('exports').notNull().default('[]'),
    publishedWhere: text('published_where'),
    publishedAt: integer('published_at'),
    retrospective: text('retrospective'),
    ...syncCols
  },
  (t) => [index('works_updated_idx').on(t.updatedAt)]
)

/** 作品的素材（溯源、知识运用率）：ref 为提示里的编号 M1…；used 表示进入了成品 */
export const workSources = sqliteTable(
  'work_sources',
  {
    id: text('id').primaryKey(),
    workId: text('work_id').notNull(),
    ref: text('ref').notNull(),
    refType: text('ref_type', { enum: ['note', 'source'] }).notNull(),
    refId: text('ref_id').notNull(),
    ownerId: text('owner_id').notNull(),
    title: text('title').notNull().default(''),
    excerpt: text('excerpt').notNull().default(''),
    used: integer('used', { mode: 'boolean' }).notNull().default(false),
    position: integer('position').notNull().default(0),
    ...syncCols
  },
  (t) => [index('work_sources_work_idx').on(t.workId), index('work_sources_ref_idx').on(t.refType, t.refId)]
)

/** 参谋与决策日志（v0.9）：一个真实问题 → 决策备忘录 → 选定与预期 → 到期回看 */
export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    question: text('question').notNull(),
    context: text('context').notNull().default(''),
    status: text('status', { enum: ['draft', 'decided', 'reviewed', 'dropped'] })
      .notNull()
      .default('draft'),
    /** 备忘录 JSON（DecisionMemo）；生成失败或尚未生成时为空 */
    memo: text('memo'),
    framework: text('framework'),
    /** 用户调整过的准则权重 JSON（覆盖备忘录里的建议权重） */
    weights: text('weights'),
    choice: text('choice'),
    expectation: text('expectation'),
    reviewAt: integer('review_at'),
    outcome: text('outcome'),
    /** 回看时的预期准确度 1–5 */
    accuracy: integer('accuracy'),
    lesson: text('lesson'),
    goalId: text('goal_id'),
    model: text('model'),
    ...syncCols
  },
  (t) => [index('decisions_review_idx').on(t.status, t.reviewAt)]
)

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
  origin: text('origin'),
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
  phaseId: text('phase_id'),
  title: text('title').notNull(),
  status: text('status', { enum: ['open', 'done', 'dropped'] })
    .notNull()
    .default('open'),
  dueAt: integer('due_at'),
  doneAt: integer('done_at'),
  reviewId: text('review_id'),
  goalId: text('goal_id'),
  ownerPersonId: text('owner_person_id'),
  ownerName: text('owner_name'),
  origin: text('origin'),
  ...syncCols
})

export const planEvents = sqliteTable(
  'plan_events',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['study', 'exam', 'deadline', 'event'] }).notNull(),
    title: text('title').notNull(),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at').notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    goalId: text('goal_id'),
    phaseId: text('phase_id'),
    status: text('status', { enum: ['planned', 'done', 'skipped'] })
      .notNull()
      .default('planned'),
    origin: text('origin', { enum: ['user', 'ai', 'ics'] })
      .notNull()
      .default('user'),
    feedId: text('feed_id'),
    uid: text('uid'),
    note: text('note'),
    ...syncCols
  },
  (t) => [index('plan_events_range_idx').on(t.startAt, t.endAt), uniqueIndex('plan_events_feed_uid_idx').on(t.feedId, t.uid, t.startAt)]
)

export const goalPhases = sqliteTable(
  'goal_phases',
  {
    origin: text('origin', { enum: ['user', 'ai'] })
      .notNull()
      .default('user'),
    objective: text('objective'),
    id: text('id').primaryKey(),
    goalId: text('goal_id').notNull(),
    title: text('title').notNull(),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at').notNull(),
    position: integer('position').notNull().default(0),
    status: text('status', { enum: ['planned', 'active', 'done'] })
      .notNull()
      .default('planned'),
    noteIds: text('note_ids').notNull().default('[]'),
    sourceIds: text('source_ids').notNull().default('[]'),
    ...syncCols
  },
  (t) => [index('goal_phases_goal_idx').on(t.goalId)]
)
export const goalMilestones = sqliteTable(
  'goal_milestones',
  {
    origin: text('origin', { enum: ['user', 'ai'] })
      .notNull()
      .default('user'),
    id: text('id').primaryKey(),
    goalId: text('goal_id').notNull(),
    phaseId: text('phase_id'),
    title: text('title').notNull(),
    at: integer('at').notNull(),
    doneAt: integer('done_at'),
    ...syncCols
  },
  (t) => [index('goal_milestones_goal_idx').on(t.goalId)]
)
export const icsFeeds = sqliteTable('ics_feeds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  color: text('color'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastFetchedAt: integer('last_fetched_at'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  error: text('error'),
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
    kind: text('kind', { enum: ['cornell', 'mistake'] })
      .notNull()
      .default('cornell'),
    mistakeId: text('mistake_id'),
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

/** 错题正文仍落在康奈尔行；此表记录识别、审阅和练习的领域状态。 */
export const mistakes = sqliteTable(
  'mistakes',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id'),
    rowId: text('row_id'),
    sourceKind: text('source_kind', { enum: ['inbox', 'capture', 'browser', 'manual'] }).notNull(),
    sourceRef: text('source_ref'),
    assetId: text('asset_id'),
    cropAssetId: text('crop_asset_id'),
    question: text('question').notNull().default(''),
    myAnswer: text('my_answer').notNull().default(''),
    correctAnswer: text('correct_answer').notNull().default(''),
    solution: text('solution').notNull().default(''),
    answerOrigin: text('answer_origin', { enum: ['image', 'ai', 'user'] })
      .notNull()
      .default('image'),
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    cause: text('cause', { enum: ['concept', 'calculation', 'reading', 'method', 'careless', 'unknown'] })
      .notNull()
      .default('unknown'),
    causeReason: text('cause_reason').notNull().default(''),
    concepts: text('concepts').notNull().default('[]'),
    subject: text('subject', { enum: ['math', 'physics', 'chemistry', 'english', 'other'] })
      .notNull()
      .default('other'),
    flags: text('flags').notNull().default('[]'),
    // 用户纠正与批次身份让下次诊断及崩溃重试都有可靠依据。
    diagnosisCorrection: integer('diagnosis_correction', { mode: 'boolean' }).notNull().default(false),
    ingestKey: text('ingest_key'),
    ...syncCols
  },
  (t) => [
    index('mistakes_note_idx').on(t.noteId),
    index('mistakes_created_idx').on(t.createdAt),
    uniqueIndex('mistakes_ingest_idx').on(t.ingestKey)
  ]
)

export const mistakeVariants = sqliteTable(
  'mistake_variants',
  {
    id: text('id').primaryKey(),
    mistakeId: text('mistake_id').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    solution: text('solution').notNull(),
    createdAt: integer('created_at').notNull(),
    usedAt: integer('used_at'),
    flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
    model: text('model')
  },
  (t) => [index('mistake_variants_pool_idx').on(t.mistakeId, t.usedAt)]
)

/** 可重建的本机缓存，没有同步列，不进入笔记内容导出。 */
export const translationCache = sqliteTable(
  'translation_cache',
  {
    id: text('id').primaryKey(),
    textHash: text('text_hash').notNull(),
    targetLanguage: text('target_language').notNull(),
    styleVersion: text('style_version').notNull(),
    translation: text('translation').notNull().default(''),
    annotations: text('annotations').notNull().default('[]'),
    model: text('model').notNull(),
    createdAt: integer('created_at').notNull(),
    usedAt: integer('used_at').notNull(),
    bytes: integer('bytes').notNull()
  },
  (t) => [
    uniqueIndex('translation_cache_key_idx').on(t.textHash, t.targetLanguage, t.styleVersion),
    index('translation_cache_used_idx').on(t.usedAt)
  ]
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

export const chatProjects = sqliteTable('chat_projects', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  color: text('color'),
  instructions: text('instructions').notNull().default(''),
  memory: text('memory', { enum: ['default', 'project'] })
    .notNull()
    .default('default'),
  libraryScope: text('library_scope', { enum: ['all', 'none'] })
    .notNull()
    .default('all'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  ...syncCols
})
export const projectSources = sqliteTable(
  'project_sources',
  {
    projectId: text('project_id').notNull(),
    itemType: text('item_type', { enum: ['note', 'source'] }).notNull(),
    itemId: text('item_id').notNull(),
    origin: text('origin', { enum: ['upload', 'library', 'text', 'url'] }).notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.projectId, t.itemType, t.itemId] }), index('project_sources_item_idx').on(t.itemType, t.itemId)]
)

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default(''),
    projectId: text('project_id'),
    /** 检索范围（JSON）：全部知识库 / 指定笔记与资料 / 不使用知识库 */
    scope: text('scope').notNull().default('{"type":"all"}'),
    web: text('web', { enum: ['off', 'auto', 'always'] }),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** 无痕：不使用、不形成记忆 */
    incognito: integer('incognito', { mode: 'boolean' }).notNull().default(false),
    /** chat 对话页；workspace 工作区面板；inline 选区就地提问 */
    kind: text('kind', { enum: ['chat', 'workspace', 'inline', 'feynman', 'reflection'] })
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
  (t) => [index('conversations_updated_idx').on(t.updatedAt), index('conversations_project_idx').on(t.projectId)]
)

/** 组件状态只属于对话回答；不进入用户知识检索。 */
export const uiStates = sqliteTable(
  'ui_states',
  {
    messageId: text('message_id').notNull(),
    componentId: text('component_id').notNull(),
    state: text('state').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.messageId, t.componentId] })]
)

/** 附件默认不给 AI；只有持有有效会话身份的专用读取通道可以放行。 */
export const conversationAttachments = sqliteTable(
  'conversation_attachments',
  {
    conversationId: text('conversation_id').notNull(),
    sourceId: text('source_id').notNull(),
    messageId: text('message_id'),
    fullTextSent: integer('full_text_sent', { mode: 'boolean' }).notNull().default(false),
    removedAt: integer('removed_at'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.sourceId] }), index('conversation_attachments_source_idx').on(t.sourceId)]
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull().default(''),
    /** 回答里的组件转成的文字（对话本身不进入知识库）。 */
    uiText: text('ui_text'),
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
    ownerType: text('owner_type', { enum: ['block', 'segment', 'annotation', 'asset'] }).notNull(),
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

/** 捕捉原件独立保留；删除使用墓碑，归档目的与提案一起记录。 */
export const inboxItems = sqliteTable(
  'inbox_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['text', 'screenshot', 'photo', 'file', 'clip', 'task', 'pick'] }).notNull(),
    text: text('text').notNull().default(''),
    assetId: text('asset_id'),
    recognized: text('recognized').notNull().default(''),
    recognitionStatus: text('recognition_status', { enum: ['pending', 'ready', 'unavailable', 'failed', 'canceled', 'none'] })
      .notNull()
      .default('none'),
    origin: text('origin').notNull().default('{}'),
    status: text('status', { enum: ['new', 'suggested', 'filed', 'dismissed'] })
      .notNull()
      .default('new'),
    suggestion: text('suggestion'),
    filedTo: text('filed_to'),
    ...syncCols
  },
  (t) => [index('inbox_status_idx').on(t.status, t.deletedAt)]
)

/** 音频仅在本机 recordings 目录；资料与转写分段沿用知识库的既有生命周期。 */
export const recordings = sqliteTable(
  'recordings',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id'),
    noteId: text('note_id'),
    scene: text('scene', { enum: ['meeting', 'lecture', 'thought', 'unspecified'] }).notNull(),
    seriesId: text('series_id'),
    sceneGuess: text('scene_guess'),
    status: text('status', { enum: ['recording', 'paused', 'finalizing', 'ready', 'failed', 'discarded'] }).notNull(),
    tracks: text('tracks').notNull(),
    startedAt: integer('started_at').notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    markers: text('markers').notNull().default('[]'),
    participants: text('participants').notNull().default('[]'),
    extraHotwords: text('extra_hotwords').notNull().default(''),
    localOnly: integer('local_only', { mode: 'boolean' }).notNull().default(false),
    preview: text('preview').notNull().default('[]'),
    error: text('error'),
    ...syncCols
  },
  (t) => [index('recordings_source_idx').on(t.sourceId)]
)

export const series = sqliteTable('series', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  scene: text('scene', { enum: ['meeting', 'lecture', 'thought', 'unspecified'] }).notNull(),
  categoryId: text('category_id'),
  ...syncCols
})
export const derivations = sqliteTable(
  'derivations',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    lens: text('lens').notNull(),
    lensTitle: text('lens_title').notNull(),
    lensHash: text('lens_hash').notNull(),
    params: text('params').notNull(),
    landing: text('landing').notNull(),
    model: text('model').notNull(),
    transcriptRevision: text('transcript_revision').notNull(),
    status: text('status', { enum: ['queued', 'running', 'ready', 'failed', 'stale', 'canceled'] }).notNull(),
    input: text('input').notNull(),
    result: text('result'),
    stats: text('stats'),
    summary: text('summary').notNull().default(''),
    jobId: text('job_id'),
    runAfter: integer('run_after').notNull(),
    ...syncCols
  },
  (t) => [index('derivations_source_idx').on(t.sourceId, t.createdAt)]
)
// 独立日志冻结用户审阅与副作用快照，重启可复用未确认的提案，撤销不改旧模型输出。
export const derivationLandings = sqliteTable(
  'derivation_landings',
  {
    id: text('id').primaryKey(),
    derivationId: text('derivation_id').notNull(),
    noteId: text('note_id'),
    proposalId: text('proposal_id'),
    undoProposalId: text('undo_proposal_id'),
    status: text('status', { enum: ['pending', 'applied', 'undoing', 'undone'] }).notNull(),
    items: text('items').notNull(),
    objects: text('objects').notNull().default('[]'),
    blocks: text('blocks').notNull().default('[]'),
    appliedAt: integer('applied_at'),
    ...syncCols
  },
  (t) => [index('landings_derivation_idx').on(t.derivationId)]
)

/** 仅由 personalSchema 导出到个人数据库；知识库只保存 personId 引用。 */
export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isMe: integer('is_me', { mode: 'boolean' }).notNull().default(false),
  note: text('note').notNull().default(''),
  mergedInto: text('merged_into'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at')
})
export const voiceprints = sqliteTable(
  'voiceprints',
  {
    id: text('id').primaryKey(),
    personId: text('person_id').notNull(),
    embedding: blob('embedding', { mode: 'buffer' }).notNull(),
    dim: integer('dim').notNull(),
    model: text('model').notNull(),
    sourceId: text('source_id'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('voiceprints_person_idx').on(t.personId)]
)
export const recordingSpeakers = sqliteTable(
  'recording_speakers',
  {
    sourceId: text('source_id').notNull(),
    label: text('label').notNull(),
    personId: text('person_id'),
    origin: text('origin', { enum: ['auto', 'user'] })
      .notNull()
      .default('auto'),
    centroid: blob('centroid', { mode: 'buffer' }),
    confidence: real('confidence'),
    skipped: integer('skipped', { mode: 'boolean' }).notNull().default(false)
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.label] })]
)
export const hotwordCorrections = sqliteTable(
  'hotword_corrections',
  {
    id: text('id').primaryKey(),
    from: text('from').notNull(),
    to: text('to').notNull(),
    count: integer('count').notNull().default(1),
    lastUsedAt: integer('last_used_at').notNull()
  },
  (t) => [uniqueIndex('hotword_pair_idx').on(t.from, t.to)]
)

/* ————————————————— 智能体底座（v0.7） ————————————————— */

/** AI 调用记账：每次请求模型一条（对话、晨报、阅读、错题、后台整理……）。cost 为美元估算，价格未知时为空 */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    date: text('date').notNull(),
    purpose: text('purpose').notNull(),
    caller: text('caller').notNull(),
    providerId: text('provider_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    cost: real('cost'),
    /** v0.7.5：同一次运行（一次回答、一个后台任务）的多次调用共用一个 run_id */
    runId: text('run_id'),
    conversationId: text('conversation_id'),
    durationMs: integer('duration_ms'),
    /** 记账时的服务商名称（服务商删除后看板仍能显示） */
    providerName: text('provider_name'),
    /** 低谷时段省下的钱（美元） */
    saved: real('saved').notNull().default(0)
  },
  (t) => [index('ai_usage_date_idx').on(t.date), index('ai_usage_run_idx').on(t.runId)]
)

/** 审计日志：每次工具调用（助手、MCP 客户端访问积微、助手使用外部工具）一条 */
export const agentAudit = sqliteTable(
  'agent_audit',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    caller: text('caller').notNull(),
    tool: text('tool').notNull(),
    level: text('level', { enum: ['read', 'write', 'external'] }).notNull(),
    summary: text('summary').notNull(),
    status: text('status', { enum: ['ok', 'error', 'denied'] }).notNull(),
    detail: text('detail'),
    durationMs: integer('duration_ms').notNull().default(0),
    conversationId: text('conversation_id')
  },
  (t) => [index('agent_audit_at_idx').on(t.at)]
)

/** 积微作为 MCP 客户端时接入的外部服务器；环境变量、请求头、OAuth 令牌用系统钥匙串加密 */
export const mcpServers = sqliteTable('mcp_servers', {
  pluginId: text('plugin_id'),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
  command: text('command'),
  args: text('args').notNull().default('[]'),
  cwd: text('cwd'),
  envEnc: blob('env_enc', { mode: 'buffer' }),
  url: text('url'),
  headersEnc: blob('headers_enc', { mode: 'buffer' }),
  oauthEnc: blob('oauth_enc', { mode: 'buffer' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** 逐个工具的策略（JSON：{ 工具名: 'auto' | 'ask' | 'deny' }） */
  toolPolicies: text('tool_policies').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/** 使用积微 MCP 服务的客户端（Claude、Cursor……）；令牌只存 SHA-256 */
export const mcpClients = sqliteTable('mcp_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  access: text('access', { enum: ['read', 'add', 'propose'] })
    .notNull()
    .default('read'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastUsedAt: integer('last_used_at'),
  createdAt: integer('created_at').notNull()
})

export const aiTasks = sqliteTable('ai_tasks', {
  pluginId: text('plugin_id'),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  instruction: text('instruction').notNull(),
  trigger: text('trigger').notNull(),
  tools: text('tools').notNull(),
  outputs: text('outputs').notNull(),
  budgetPerRun: real('budget_per_run'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  recipe: text('recipe'),
  lastRunAt: integer('last_run_at'),
  nextRunAt: integer('next_run_at'),
  ...syncCols
})
export const aiTaskRuns = sqliteTable(
  'ai_task_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    status: text('status', { enum: ['running', 'ok', 'error', 'skipped', 'budget', 'canceled'] }).notNull(),
    delayed: integer('delayed', { mode: 'boolean' }).notNull().default(false),
    triggerInfo: text('trigger_info').notNull().default('{}'),
    cost: real('cost').notNull().default(0),
    summary: text('summary'),
    resultRefs: text('result_refs').notNull().default('[]'),
    error: text('error'),
    conversationId: text('conversation_id')
  },
  (t) => [index('ai_task_runs_task_idx').on(t.taskId, t.startedAt)]
)

export const mailAccounts = sqliteTable('mail_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  preset: text('preset').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull().default(993),
  tls: integer('tls', { mode: 'boolean' }).notNull().default(true),
  username: text('username').notNull(),
  secretEnc: blob('secret_enc', { mode: 'buffer' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastError: text('last_error'),
  ...syncCols
})
export const mailSeen = sqliteTable(
  'mail_seen',
  {
    accountId: text('account_id').notNull(),
    mailbox: text('mailbox').notNull(),
    uidValidity: text('uid_validity').notNull(),
    lastUid: integer('last_uid').notNull()
  },
  (t) => [primaryKey({ columns: [t.accountId, t.mailbox] })]
)

export const feeds = sqliteTable('feeds', {
  pluginId: text('plugin_id'),
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  url: text('url').notNull(),
  title: text('title').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  goalId: text('goal_id'),
  lastFetchedAt: integer('last_fetched_at'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  error: text('error'),
  contentHash: text('content_hash'),
  ...syncCols
})
export const feedItems = sqliteTable(
  'feed_items',
  {
    id: text('id').primaryKey(),
    feedId: text('feed_id'),
    url: text('url').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    author: text('author'),
    publishedAt: integer('published_at'),
    fetchedAt: integer('fetched_at').notNull(),
    origin: text('origin', { enum: ['feed', 'search'] }).notNull(),
    status: text('status', { enum: ['new', 'scored', 'picked', 'dismissed', 'saved', 'later'] })
      .notNull()
      .default('new'),
    score: text('score'),
    reason: text('reason'),
    related: text('related').notNull().default('[]'),
    gap: text('gap'),
    minutes: integer('minutes'),
    pickedAt: integer('picked_at'),
    laterAt: integer('later_at'),
    audioUrl: text('audio_url'),
    pdfUrl: text('pdf_url'),
    inboxId: text('inbox_id'),
    remedyId: text('remedy_id'),
    ...syncCols
  },
  (t) => [uniqueIndex('feed_items_url_idx').on(t.url), index('feed_items_status_idx').on(t.status)]
)
export const discoverFeedback = sqliteTable('discover_feedback', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull(),
  action: text('action').notNull(),
  at: integer('at').notNull(),
  topic: text('topic').notNull(),
  reason: text('reason')
})
export const searchConnections = sqliteTable('search_connections', {
  service: text('service').primaryKey(),
  keyEnc: blob('key_enc', { mode: 'buffer' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull()
})

/** 旧搜索连接保留不删；迁移只复制密文，避免升级损失凭证。 */
export const searchBackends = sqliteTable('search_backends', {
  id: text('id').primaryKey(),
  keyEnc: blob('key_enc', { mode: 'buffer' }),
  keyProviderId: text('key_provider_id'),
  baseUrl: text('base_url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull()
})

export const webSearchCache = sqliteTable(
  'web_search_cache',
  {
    key: text('key').primaryKey(),
    backend: text('backend').notNull(),
    results: text('results').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull()
  },
  (t) => [index('web_search_cache_expires_idx').on(t.expiresAt)]
)

export const webPages = sqliteTable(
  'web_pages',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    provider: text('provider', { enum: ['local', 'deepseek'] })
      .notNull()
      .default('local'),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    title: text('title').notNull().default(''),
    siteName: text('site_name'),
    publishedAt: integer('published_at'),
    fetchedAt: integer('fetched_at').notNull(),
    method: text('method', { enum: ['fetch', 'render', 'pdf'] }).notNull(),
    lang: text('lang'),
    text: text('text').notNull(),
    textHash: text('text_hash').notNull()
  },
  (t) => [index('web_pages_url_idx').on(t.url), uniqueIndex('web_pages_url_hash_provider_uq').on(t.url, t.textHash, t.provider)]
)

export const webPageRefs = sqliteTable(
  'web_page_refs',
  {
    pageId: text('page_id').notNull(),
    messageId: text('message_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.pageId, t.messageId] }), index('web_page_refs_conv_idx').on(t.conversationId)]
)

export const retrievalCalls = sqliteTable(
  'retrieval_calls',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    date: text('date').notNull(),
    backend: text('backend').notNull(),
    kind: text('kind', { enum: ['search', 'fetch', 'render', 'pdf'] }).notNull(),
    purpose: text('purpose').notNull(),
    runId: text('run_id'),
    conversationId: text('conversation_id'),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    cached: integer('cached', { mode: 'boolean' }).notNull(),
    durationMs: integer('duration_ms')
  },
  (t) => [index('retrieval_calls_date_idx').on(t.date)]
)

/** 插件凭证仅存密文；生命周期事务由 plugins/install 维护。 */
export const pluginMarkets = sqliteTable('plugin_markets', {
  name: text('name').primaryKey(),
  source: text('source').notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  catalog: text('catalog'),
  fetchedAt: integer('fetched_at'),
  error: text('error'),
  addedAt: integer('added_at').notNull()
})
export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(),
  market: text('market').notNull(),
  version: text('version').notNull(),
  previousVersion: text('previous_version'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  capabilities: text('capabilities').notNull(),
  config: text('config').notNull().default('{}'),
  secretsEnc: blob('secrets_enc', { mode: 'buffer' }),
  installedAt: integer('installed_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/** 笔记库导入（v0.11）：扫描是可续传的预览清单，运行与条目用于去重和整体撤销。 */
export const importScans = sqliteTable('import_scans', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
  createdAt: integer('created_at').notNull()
})
export const importRuns = sqliteTable(
  'import_runs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    rootLabel: text('root_label').notNull(),
    rootHash: text('root_hash').notNull(),
    options: text('options').notNull(),
    data: text('data').notNull(),
    createdAt: integer('created_at').notNull(),
    undoneAt: integer('undone_at')
  },
  (t) => [index('import_runs_root_idx').on(t.rootHash)]
)
export const importItems = sqliteTable(
  'import_items',
  {
    runId: text('run_id').notNull(),
    sourceKey: text('source_key').notNull(),
    contentHash: text('content_hash').notNull(),
    noteId: text('note_id'),
    status: text('status').notNull(),
    message: text('message'),
    complete: integer('complete', { mode: 'boolean' }).notNull().default(false),
    data: text('data').notNull()
  },
  (t) => [primaryKey({ columns: [t.runId, t.sourceKey] }), index('import_items_note_idx').on(t.noteId)]
)

/** 长任务可恢复的中间结果，任务完成与来源删除时清理。 */
export const jobSteps = sqliteTable(
  'job_steps',
  {
    jobId: text('job_id').notNull(),
    stepKey: text('step_key').notNull(),
    sourceId: text('source_id'),
    output: text('output').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.jobId, t.stepKey] })]
)

/** 归档过的附件：来源记录被彻底删除后，派生笔记仍按“已公开”处理，不重新上锁。 */
export const releasedAttachments = sqliteTable('released_attachments', {
  sourceId: text('source_id').primaryKey(),
  releasedAt: integer('released_at').notNull()
})
