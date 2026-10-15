import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const f = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  profile: null as Database.Database | null,
  db: null as ReturnType<typeof drizzle> | null
}))
vi.mock('../../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../../../db/profile', () => ({ profileDb: () => f.profile }))
vi.mock('../../../events', () => ({ emit: () => {} }))
vi.mock('../../device', () => ({ deviceId: () => 'test-device' }))
vi.mock('electron', () => ({ dialog: {}, app: {}, BrowserWindow: {}, ipcMain: { on: () => {} } }))
vi.mock('../../memory', () => ({
  promoteProjectMemories: (id: string) => f.profile!.prepare('UPDATE memories SET project_id=NULL WHERE project_id=?').run(id).changes,
  deleteProjectMemories: (id: string) => f.profile!.prepare('DELETE FROM memories WHERE project_id=?').run(id).changes
}))
import { createProject, getProject, listProjects, updateProject, removeProject } from '../projects'

beforeEach(() => {
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  for (const name of readdirSync(join(process.cwd(), 'resources/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(process.cwd(), 'resources/migrations', name), 'utf8'))
  f.db = drizzle(f.sql)
  f.profile = new Database(':memory:')
  f.profile.exec('CREATE TABLE memories(id TEXT PRIMARY KEY, project_id TEXT, content TEXT)')
})
afterEach(() => {
  f.sql?.close()
  f.profile?.close()
})
describe('chat project lifecycle', () => {
  it('creates and renames a project and rejects invalid name/mode transitions', () => {
    const p = createProject({ name: ' 项目 ', memory: 'default', libraryScope: 'none', instructions: '' })
    expect(p).toMatchObject({ name: '项目', memory: 'default', libraryScope: 'none', memoryCount: 0 })
    expect(updateProject(p.id, { name: '新名称', pinned: true })).toMatchObject({ name: '新名称', pinned: true })
    expect(() => updateProject(p.id, { memory: 'project' })).toThrow()
    expect(() => createProject({ name: ' ', memory: 'default', libraryScope: 'all', instructions: '' })).toThrow()
    expect(listProjects()).toHaveLength(1)
  })
  it('requires explicit confirmation before making project memories global', () => {
    const p = createProject({ name: '私有', memory: 'project', libraryScope: 'all', instructions: '' })
    f.profile!.prepare('INSERT INTO memories VALUES(?,?,?)').run('m', p.id, 'private marker')
    expect(getProject(p.id)?.memoryCount).toBe(1)
    expect(() => updateProject(p.id, { memory: 'default' })).toThrow()
    expect(f.profile!.prepare('SELECT project_id FROM memories').get()).toEqual({ project_id: p.id })
    expect(updateProject(p.id, { memory: 'default', promoteMemories: true }).memoryCount).toBe(0)
    expect(f.profile!.prepare('SELECT project_id FROM memories').get()).toEqual({ project_id: null })
  })
  it('soft deletes the project, moves conversations to recent, and removes its memories', async () => {
    const p = createProject({ name: '删除', memory: 'project', libraryScope: 'all', instructions: '' })
    f.sql!.prepare("INSERT INTO conversations(id,title,project_id,created_at,updated_at) VALUES('c','conversation',?,1,1)").run(p.id)
    f.profile!.prepare('INSERT INTO memories VALUES(?,?,?)').run('m', p.id, 'marker')
    await removeProject(p.id, 'recent')
    expect(getProject(p.id)).toBeNull()
    expect(f.sql!.prepare("SELECT project_id FROM conversations WHERE id='c'").get()).toEqual({ project_id: null })
    expect(f.profile!.prepare('SELECT * FROM memories').all()).toEqual([])
  })
})
