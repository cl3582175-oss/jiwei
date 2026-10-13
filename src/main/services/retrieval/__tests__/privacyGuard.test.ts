import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { setMessageLanguage } from '../../../lib/messages'

const fixture = vi.hoisted(() => ({ db: null as Database.Database | null }))
vi.mock('../../../db', () => ({ getSqlite: () => fixture.db }))
import { check, PrivacyError } from '../privacyGuard'

let db: Database.Database
let queries: string[]
beforeEach(() => {
  queries = []
  db = new Database(':memory:', { verbose: (query) => queries.push(String(query)) })
  fixture.db = db
  // 只建立隐私守卫所需列；不加载应用数据库，不产生迁移文件。
  db.exec(`CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT NOT NULL, plain_text TEXT NOT NULL, ai_excluded INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE sources(id TEXT PRIMARY KEY, title TEXT NOT NULL, ai_excluded INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE source_segments(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, text TEXT NOT NULL);`)
  queries = []
})
afterEach(() => {
  db.close()
  fixture.db = null
  setMessageLanguage('zh-CN')
})
function note(title: string, text: string, excluded = 1, deleted: number | null = null): void {
  db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?)').run('note-1', title, text, excluded, deleted)
}
function source(title: string, text: string, excluded = 1, deleted: number | null = null): void {
  db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?)').run('source-1', title, excluded, deleted)
  db.prepare('INSERT INTO source_segments VALUES (?, ?, ?)').run('segment-1', 'source-1', text)
}

describe('excluded content search privacy', () => {
  it.each(['note', 'source'] as const)('blocks the complete >=4 character %s title', (kind) => {
    if (kind === 'note') note('保密资料', '')
    else source('保密资料', '')
    expect(check('请查保密资料的后续进展')).toBe(false)
  })
  it('allows partial titles and titles below four characters', () => {
    note('内部数据', '')
    expect(check('内部')).toBe(true)
    db.prepare('UPDATE notes SET title = ?').run('私密文')
    expect(check('私密文')).toBe(true)
  })
  it('counts Unicode characters rather than UTF-16 units for title length', () => {
    note('𠮷𠮷𠮷', '')
    expect(check('𠮷𠮷𠮷')).toBe(true)
    db.prepare('UPDATE notes SET title = ?').run('𠮷𠮷𠮷𠮷')
    expect(check('𠮷𠮷𠮷𠮷')).toBe(false)
  })
  it.each(['note', 'source'] as const)('blocks a ten-character Chinese substring in %s body', (kind) => {
    if (kind === 'note') note('短名', '前文甲乙丙丁戊己庚辛壬癸后文')
    else source('短名', '前文甲乙丙丁戊己庚辛壬癸后文')
    expect(check('搜索甲乙丙丁戊己庚辛壬癸说明')).toBe(false)
  })
  it.each(['note', 'source'] as const)('allows a nine-character Chinese substring in %s body', (kind) => {
    if (kind === 'note') note('短名', '甲乙丙丁戊己庚辛壬癸')
    else source('短名', '甲乙丙丁戊己庚辛壬癸')
    expect(check('甲乙丙丁戊己庚辛壬')).toBe(true)
  })
  it('counts astral Han characters as individual ten-character window members', () => {
    note('短名', '𠮷甲乙丙丁戊己庚辛壬')
    expect(check('𠮷甲乙丙丁戊己庚辛')).toBe(true)
    expect(check('𠮷甲乙丙丁戊己庚辛壬')).toBe(false)
  })
  it.each(['note', 'source'] as const)('blocks a four-word English phrase in %s body case-insensitively', (kind) => {
    if (kind === 'note') note('x', 'Before ALPHA beta Gamma DELTA after')
    else source('x', 'Before ALPHA beta Gamma DELTA after')
    expect(check('Please find alpha BETA gamma delta today')).toBe(false)
  })
  it.each(['note', 'source'] as const)('allows only three copied English words from %s body', (kind) => {
    if (kind === 'note') note('x', 'alpha beta gamma delta')
    else source('x', 'alpha beta gamma delta')
    expect(check('alpha beta gamma')).toBe(true)
  })
  it('switches to ten-character windows whenever the query contains Han characters', () => {
    note('x', 'a b c d')
    expect(check('中 a b c d')).toBe(true)
  })
  it('matches full titles case-insensitively', () => {
    note('Secret Plan', '')
    expect(check('find sEcReT pLaN')).toBe(false)
  })
  it.each(['note', 'source'] as const)('ignores deleted excluded %s titles and body', (kind) => {
    if (kind === 'note') note('保密资料', '甲乙丙丁戊己庚辛壬癸', 1, 1)
    else source('保密资料', '甲乙丙丁戊己庚辛壬癸', 1, 1)
    expect(check('保密资料甲乙丙丁戊己庚辛壬癸')).toBe(true)
  })
  it('ignores allowed content and rechecks exclusion changes on the next call', () => {
    note('保密资料', '甲乙丙丁戊己庚辛壬癸', 0)
    source('Secret Plan', 'alpha beta gamma delta', 0)
    expect(check('保密资料甲乙丙丁戊己庚辛壬癸')).toBe(true)
    expect(check('Secret Plan alpha beta gamma delta')).toBe(true)
    db.prepare('UPDATE notes SET ai_excluded = 1').run()
    expect(check('保密资料')).toBe(false)
    db.prepare('UPDATE notes SET ai_excluded = 0').run()
    expect(check('保密资料')).toBe(true)
  })
  it('returns after one metadata query when no content is excluded', () => {
    note('Allowed content', 'alpha beta gamma delta', 0)
    queries = []
    expect(check('alpha beta gamma delta')).toBe(true)
    expect(queries).toHaveLength(1)
    expect(queries[0]).not.toMatch(/plain_text|source_segments/)
  })
  it('stops searching body windows after the first match', () => {
    note('x', '甲乙丙丁戊己庚辛壬癸')
    queries = []
    expect(check('甲乙丙丁戊己庚辛壬癸后续文字')).toBe(false)
    expect(queries.filter((query) => query.includes('instr('))).toHaveLength(1)
  })
  it('treats SQL-like input as literal query data', () => {
    note('x', 'alpha beta gamma delta')
    expect(check("unrelated words ' OR 1=1 --")).toBe(true)
    expect(db.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 1 })
  })
  it.each([
    ['zh-CN', '搜索词里含有你设为“不给 AI”的内容，已拦截'],
    ['en', 'The query contains content you excluded from AI; blocked']
  ])('reports the prescribed privacy message in %s without query content', (language, message) => {
    setMessageLanguage(language)
    expect(new PrivacyError().message).toBe(message)
  })
})
