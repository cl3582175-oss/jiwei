import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

it('upgrades existing local snapshots without losing text, URL identity, references or source rows', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE web_pages (id TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', site_name TEXT, published_at INTEGER, fetched_at INTEGER NOT NULL, method TEXT NOT NULL, lang TEXT, text TEXT NOT NULL, text_hash TEXT NOT NULL);
      CREATE UNIQUE INDEX web_pages_url_hash_uq ON web_pages(url,text_hash);
      CREATE INDEX web_pages_url_idx ON web_pages(url);
      CREATE TABLE sources(id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE web_page_refs(page_id TEXT, message_id TEXT);
      INSERT INTO web_pages(id,url,final_url,title,fetched_at,method,text,text_hash) VALUES('old-page','https://example.org/start','https://example.org/final','Existing title',123,'fetch','Existing exact text','same-hash');
      INSERT INTO sources VALUES('existing-source','Personal material');
      INSERT INTO web_page_refs VALUES('old-page','old-message');`)
    for (const statement of readFileSync('resources/migrations/0040_webpage_reader_provenance.sql', 'utf8').split(
      '--> statement-breakpoint'
    ))
      if (statement.trim()) db.exec(statement)
    expect(db.prepare('SELECT id,final_url,text,provider,truncated FROM web_pages').get()).toEqual({
      id: 'old-page',
      final_url: 'https://example.org/final',
      text: 'Existing exact text',
      provider: 'local',
      truncated: 0
    })
    expect(db.prepare('SELECT * FROM web_page_refs').get()).toEqual({ page_id: 'old-page', message_id: 'old-message' })
    expect(db.prepare('SELECT * FROM sources').get()).toEqual({ id: 'existing-source', title: 'Personal material', web_origin: null })
    db.exec(
      `INSERT INTO web_pages(id,url,final_url,fetched_at,method,text,text_hash,provider) VALUES('cloud-page','https://example.org/start',NULL,456,'fetch','Existing exact text','same-hash','deepseek')`
    )
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_pages').get()).toEqual({ n: 2 })
  } finally {
    db.close()
  }
})
