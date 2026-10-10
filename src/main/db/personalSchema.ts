export { people, voiceprints, recordingSpeakers } from './schema'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// 词汇能力与已知词属于人，不能随知识库迁移、共享或导出。
export const vocabularyProfile = sqliteTable('vocabulary_profile', {
  id: text('id').primaryKey().default('self'),
  vocabThreshold: integer('vocab_threshold').notNull().default(6000),
  vocabHistory: text('vocab_history').notNull().default('[]'),
  pendingSignals: text('pending_signals').notNull().default('[]'),
  initialized: integer('initialized', { mode: 'boolean' }).notNull().default(false)
})
export const knownWords = sqliteTable('known_words', {
  word: text('word').primaryKey(),
  addedAt: integer('added_at').notNull(),
  source: text('source').notNull().default('recognize')
})
