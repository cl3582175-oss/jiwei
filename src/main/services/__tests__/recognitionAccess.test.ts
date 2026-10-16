import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
const f = vi.hoisted(() => ({ sql: null as Database.Database | null }))
vi.mock('../../db', () => ({ getSqlite: () => f.sql }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('electron-log/main', () => ({ default: { warn: () => {} } }))
import { recognitionScope, guardRecognition } from '../recognitionAccess'
import { emit } from '../../events'
beforeEach(() => {
  f.sql = new Database(':memory:')
  f.sql.exec(`CREATE TABLE sources(id TEXT,space TEXT,ai_excluded INTEGER,deleted_at INTEGER);
    CREATE TABLE chat_projects(id TEXT,deleted_at INTEGER);
    CREATE TABLE project_sources(project_id TEXT,item_type TEXT,item_id TEXT,origin TEXT,created_at INTEGER);
    INSERT INTO sources VALUES('public','library',0,NULL),('excluded','library',1,NULL),('private','attachment',1,NULL),('orphan','attachment',1,NULL);
    INSERT INTO chat_projects VALUES('A',NULL),('B',NULL);
    INSERT INTO project_sources VALUES('A','source','private','upload',10);`)
})
afterEach(() => f.sql?.close())
it('allows cloud OCR only for readable library or live owned private project sources', () => {
  expect(recognitionScope('public', 'cloud')).toBe('library:public')
  expect(recognitionScope('excluded', 'cloud')).toBeNull()
  expect(recognitionScope('private', 'cloud')).toBe('project:A:10')
  expect(recognitionScope('orphan', 'cloud')).toBeNull()
  expect(recognitionScope('excluded', 'local')).not.toBeNull()
  f.sql!.exec("UPDATE chat_projects SET deleted_at=1 WHERE id='A'")
  expect(recognitionScope('private', 'cloud')).toBeNull()
})
it('rejects a library-excluded source even if it has a project reference', () => {
  f.sql!.exec("INSERT INTO project_sources VALUES('A','source','excluded','library',10)")
  expect(recognitionScope('excluded', 'cloud')).toBeNull()
})
it('aborts in-flight work when the project relation is removed, including remove then re-add', () => {
  const guard = guardRecognition('private', 'cloud', () => true)
  try {
    guard.check()
    f.sql!.exec("DELETE FROM project_sources WHERE item_id='private'")
    emit('chatProjects:changed', {})
    expect(guard.signal.aborted).toBe(true)
    expect(guard.canApply()).toBe(false)
    f.sql!.exec("INSERT INTO project_sources VALUES('A','source','private','upload',10)")
    expect(() => guard.check()).toThrow(/access changed/)
  } finally {
    guard.dispose()
  }
})
it('rechecks settings, deletion and source scope before retries and result writes', () => {
  let valid = true
  const guard = guardRecognition('private', 'cloud', () => valid)
  try {
    valid = false
    emit('settings:changed', {})
    expect(() => guard.check()).toThrow(/access changed/)
  } finally {
    guard.dispose()
  }
  const local = guardRecognition('private', 'local', () => true)
  try {
    f.sql!.exec("UPDATE sources SET deleted_at=1 WHERE id='private'")
    expect(() => local.check()).toThrow(/access changed/)
  } finally {
    local.dispose()
  }
})
it('honors parent cancellation and does not leave business event subscriptions active', () => {
  const controller = new AbortController()
  const guard = guardRecognition('private', 'cloud', () => true, controller.signal)
  controller.abort(new Error('cancelled'))
  expect(() => guard.check()).toThrow('cancelled')
  expect(guard.canApply()).toBe(true)
  guard.dispose()
  f.sql!.close()
  f.sql = null
  expect(() => emit('chatProjects:changed', {})).not.toThrow()
})
it('aborts when provider or settings lookup fails while authorization is being refreshed', () => {
  let removed = false
  const guard = guardRecognition('private', 'cloud', () => {
    if (removed) throw new Error('provider removed')
    return true
  })
  try {
    removed = true
    emit('providers:changed', {})
    expect(guard.signal.aborted).toBe(true)
    expect(guard.canApply()).toBe(false)
  } finally {
    guard.dispose()
  }
})
