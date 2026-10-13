import { getSqlite } from '../../db'
import { emit } from '../../events'
import { localDate } from '../stats'

export function cleanupRetrieval(): void {
  const db = getSqlite(),
    date = localDate(),
    now = Date.now()
  db.transaction(() => {
    if ((db.prepare('SELECT value FROM meta WHERE key=?').get('retrieval.cleanup') as { value: string } | undefined)?.value === date) return
    db.prepare('DELETE FROM web_search_cache WHERE expires_at < ?').run(now)
    db.prepare(
      'DELETE FROM web_search_cache WHERE key IN (SELECT key FROM web_search_cache ORDER BY created_at DESC LIMIT -1 OFFSET 5000)'
    ).run()
    db.prepare('DELETE FROM web_pages WHERE fetched_at < ? AND NOT EXISTS (SELECT 1 FROM web_page_refs WHERE page_id = web_pages.id)').run(
      now - 30 * 86_400_000
    )
    db.prepare('DELETE FROM retrieval_calls WHERE at < ?').run(now - 400 * 86_400_000)
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('retrieval.cleanup', date)
  })()
}

export function clearRetrievalCache(): { searches: number; pages: number } {
  const db = getSqlite()
  const result = db.transaction(() => ({
    searches: db.prepare('DELETE FROM web_search_cache').run().changes,
    pages: db.prepare('DELETE FROM web_pages WHERE NOT EXISTS (SELECT 1 FROM web_page_refs WHERE page_id = web_pages.id)').run().changes
  }))()
  emit('retrieval:changed', {})
  return result
}
