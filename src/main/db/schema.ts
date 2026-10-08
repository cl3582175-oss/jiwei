import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'

// 修改本文件后执行 `npm run db:generate` 生成迁移，应用启动时会自动迁移。

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['note', 'source'] }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull()
})

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default(''),
    categoryId: text('category_id'),
    cue: text('cue').notNull(),
    content: text('content').notNull(),
    summary: text('summary').notNull(),
    plainText: text('plain_text').notNull().default(''),
    wordCount: integer('word_count').notNull().default(0),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at')
  },
  (t) => [index('notes_category_idx').on(t.categoryId), index('notes_deleted_idx').on(t.deletedAt)]
)

export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    /** 相对于资料库目录的文件路径；网址类资料为空 */
    filePath: text('file_path'),
    originalName: text('original_name'),
    mime: text('mime'),
    size: integer('size').notNull().default(0),
    url: text('url'),
    categoryId: text('category_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at')
  },
  (t) => [index('sources_category_idx').on(t.categoryId), index('sources_deleted_idx').on(t.deletedAt)]
)

/** 笔记之间的双向关联（v0.4 知识图谱使用） */
export const noteLinks = sqliteTable(
  'note_links',
  {
    fromId: text('from_id').notNull(),
    toId: text('to_id').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.fromId, t.toId] })]
)

/** 笔记与原始资料的引用锚点（页码 / 时间戳 / 段落等） */
export const noteSources = sqliteTable(
  'note_sources',
  {
    noteId: text('note_id').notNull(),
    sourceId: text('source_id').notNull(),
    anchor: text('anchor'),
    createdAt: integer('created_at').notNull()
  },
  (t) => [index('note_sources_note_idx').on(t.noteId), index('note_sources_source_idx').on(t.sourceId)]
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
