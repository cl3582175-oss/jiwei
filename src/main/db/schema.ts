import { sqliteTable, text, integer, blob, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core'

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

/** 本机元数据：设备 ID 等 */
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
    categoryId: text('category_id'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** 学习日期：知识是什么时候学到的（可手动修改，默认等于创建时间） */
    learnedAt: integer('learned_at').notNull(),
    /** 知识状态：有效 / 已过时 / 存疑 */
    status: text('status', { enum: ['active', 'outdated', 'disputed'] }).notNull().default('active'),
    /** 被哪篇笔记取代 */
    supersededBy: text('superseded_by'),
    /** 隐私：为 true 时永不发送给 AI */
    aiExcluded: integer('ai_excluded', { mode: 'boolean' }).notNull().default(false),
    /** 文档格式版本，编辑器结构升级时用于迁移旧文档 */
    docVersion: integer('doc_version').notNull().default(1),
    // 以下为从 Yjs 文档派生的字段（检索、列表、统计用）
    plainText: text('plain_text').notNull().default(''),
    wordCount: integer('word_count').notNull().default(0),
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
  (t) => [index('sources_category_idx').on(t.categoryId), index('sources_deleted_idx').on(t.deletedAt), index('sources_asset_idx').on(t.assetId)]
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
    fromType: text('from_type', { enum: ['note', 'source'] }).notNull(),
    fromId: text('from_id').notNull(),
    fromBlockId: text('from_block_id'),
    toType: text('to_type', { enum: ['note', 'source', 'url'] }).notNull(),
    toId: text('to_id').notNull(),
    toSelector: text('to_selector'),
    relation: text('relation', { enum: ['reference', 'related', 'supersedes'] }).notNull().default('reference'),
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
