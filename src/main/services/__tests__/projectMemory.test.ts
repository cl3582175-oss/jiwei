import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const fixture = vi.hoisted(() => ({ directory: '', events: [] as { event: string; payload: unknown }[] }))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.directory, getAppPath: () => process.cwd(), isPackaged: false },
  dialog: {},
  shell: {}
}))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {} } }))
vi.mock('../../events', () => ({ emit: (event: string, payload: unknown) => fixture.events.push({ event, payload }) }))
vi.mock('../settings', () => ({ getSettings: () => ({ ai: {} }), setSettings: () => {} }))
vi.mock('../plugins/registry', () => ({ pluginRegistryRevision: () => 0, enabledPlugins: () => [] }))

import { closeProfileDb, profileDb, profileDbPath } from '../../db/profile'
import * as memory from '../memory'
import { loadSkill, reloadSkills } from '../ai/skills'

const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'jiwei-project-memory-'))
  fixture.events = []
})
afterEach(() => {
  closeProfileDb()
  rmSync(fixture.directory, { recursive: true, force: true })
})

describe('project memory boundaries', () => {
  it('upgrades a version-2 personal database without changing legacy global rows and persists scopes on reopen', () => {
    mkdirSync(join(fixture.directory, 'profile'), { recursive: true })
    const legacy = new Database(profileDbPath())
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT, skill TEXT, content TEXT NOT NULL,
      sensitive INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 1, origin TEXT NOT NULL, evidence TEXT, valid_from INTEGER NOT NULL,
      invalid_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX memories_kind_key ON memories(kind, key) WHERE key IS NOT NULL;
    CREATE TABLE skill_feedback (id TEXT PRIMARY KEY, skill TEXT NOT NULL, kind TEXT NOT NULL, note_id TEXT, block_ids TEXT,
      before TEXT NOT NULL, after TEXT, created_at INTEGER NOT NULL, checked_at INTEGER, consumed_at INTEGER);
    INSERT INTO memories(id,kind,key,content,origin,valid_from,created_at,updated_at) VALUES('legacy','episode','conv:same','LEGACY-GLOBAL','ai',1,1,1);
    PRAGMA user_version = 2;`)
    legacy.close()
    expect((profileDb().prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map((row) => row.name)).toContain('project_id')
    expect(memory.getMemory('legacy')).toMatchObject({ content: 'LEGACY-GLOBAL', projectId: null })
    const scoped = memory.saveMemory({ kind: 'episode', key: 'conv:same', content: 'PROJECT-PERSISTED', projectId: PROJECT_A }, 'ai')
    closeProfileDb()
    expect(memory.getMemory(scoped.id)).toMatchObject({ content: 'PROJECT-PERSISTED', projectId: PROJECT_A })
    expect(memory.listMemories().map((row) => row.content)).toEqual(['LEGACY-GLOBAL'])
    expect(profileDb().pragma('user_version', { simple: true })).toBe(3)
  })

  it('includes the global profile and only the selected scope in cards, including episodes', () => {
    memory.setUserProfile({ role: 'PROFILE-MARKER', goals: 'PROFILE-GOALS' })
    memory.saveMemory({ kind: 'fact', content: 'GLOBAL-MARKER' }, 'ai')
    memory.saveMemory({ kind: 'fact', content: 'PROJECT-A-MARKER', projectId: PROJECT_A }, 'ai')
    memory.saveMemory({ kind: 'fact', content: 'PROJECT-B-MARKER', projectId: PROJECT_B }, 'ai')
    memory.saveMemory({ kind: 'episode', content: 'GLOBAL-EPISODE', key: 'global-episode' }, 'ai')
    memory.saveMemory({ kind: 'episode', content: 'PROJECT-A-EPISODE', key: 'a-episode', projectId: PROJECT_A }, 'ai')
    memory.saveMemory({ kind: 'episode', content: 'PROJECT-B-EPISODE', key: 'b-episode', projectId: PROJECT_B }, 'ai')

    const global = memory.userCard(true)!
    const a = memory.userCard(true, { projectId: PROJECT_A })!
    const b = memory.userCard(false, { projectId: PROJECT_B })!
    for (const card of [global, a, b]) {
      expect(card).toContain('PROFILE-MARKER')
      expect(card).toContain('PROFILE-GOALS')
    }
    expect(global).toContain('GLOBAL-MARKER')
    expect(global).toContain('GLOBAL-EPISODE')
    expect(global).not.toContain('PROJECT-')
    expect(a).toContain('PROJECT-A-MARKER')
    expect(a).toContain('PROJECT-A-EPISODE')
    expect(a).not.toContain('GLOBAL-')
    expect(a).not.toContain('PROJECT-B-')
    expect(b).toContain('PROJECT-B-MARKER')
    expect(b).toContain('PROJECT-B-EPISODE')
    expect(b).not.toContain('GLOBAL-')
    expect(b).not.toContain('PROJECT-A-')
  })

  it('filters list, FTS, and short LIKE searches before limits and records use only in that scope', () => {
    const global = memory.saveMemory({ kind: 'fact', content: 'SEARCH-TOKEN global 共词' }, 'user')
    const a = memory.saveMemory({ kind: 'fact', content: 'SEARCH-TOKEN project A 共词', projectId: PROJECT_A }, 'user')
    const b = memory.saveMemory({ kind: 'fact', content: 'SEARCH-TOKEN project B 共词', projectId: PROJECT_B }, 'user')

    expect(memory.listMemories().map((row) => row.id)).toEqual([global.id])
    expect(memory.listMemories({ projectId: null }).map((row) => row.id)).toEqual([global.id])
    expect(memory.listMemories({ projectId: PROJECT_A }).map((row) => row.id)).toEqual([a.id])
    expect(memory.listMemories({ projectId: PROJECT_B }).map((row) => row.id)).toEqual([b.id])
    for (const query of ['SEARCH-TOKEN', '共词']) {
      expect(memory.searchMemories(query, 1).map((row) => row.id)).toEqual([global.id])
      expect(memory.searchMemories(query, 1, { projectId: PROJECT_A }).map((row) => row.id)).toEqual([a.id])
    }
    expect(memory.getMemory(global.id)?.useCount).toBe(2)
    expect(memory.getMemory(a.id)?.useCount).toBe(2)
    expect(memory.getMemory(b.id)?.useCount).toBe(0)
  })

  it('deduplicates identical content and keyed memories within each scope', () => {
    const scopes = [null, PROJECT_A, PROJECT_B]
    const ids = scopes.map((projectId) => memory.saveMemory({ kind: 'fact', content: 'Same preference', projectId }, 'ai').id)
    expect(new Set(ids).size).toBe(3)
    scopes.forEach((projectId, index) => {
      expect(memory.saveMemory({ kind: 'fact', content: 'Same preference.', projectId }, 'ai').id).toBe(ids[index])
    })
    const episodes = scopes.map((projectId) =>
      memory.saveMemory({ kind: 'episode', key: 'conv:shared', content: `Study ${projectId ?? 'global'}`, projectId }, 'ai')
    )
    expect(new Set(episodes.map((row) => row.id)).size).toBe(3)
    scopes.forEach((projectId, index) => {
      expect(memory.saveMemory({ kind: 'episode', key: 'conv:shared', content: 'Updated', projectId }, 'ai').id).toBe(episodes[index].id)
    })
  })

  it('preserves the scope of administrative ID edits and always stores profiles globally', () => {
    const scoped = memory.saveMemory({ kind: 'preference', content: 'Project preference', projectId: PROJECT_A }, 'user')
    const edited = memory.saveMemory({ id: scoped.id, kind: 'preference', content: 'Edited', projectId: PROJECT_B }, 'user')
    expect(edited.projectId).toBe(PROJECT_A)
    expect(memory.listMemories({ projectId: PROJECT_A }).map((row) => row.content)).toEqual(['Edited'])
    expect(memory.listMemories({ projectId: PROJECT_B })).toEqual([])
    memory.saveMemory({ kind: 'profile', key: 'role', content: 'Global role', projectId: PROJECT_A }, 'user')
    expect(memory.getUserProfile()).toEqual({ role: 'Global role' })
    expect(memory.listMemories({ projectId: PROJECT_A })).toHaveLength(1)
    expect(memory.listMemories({ kind: 'profile' })[0].projectId).toBeNull()
    memory.saveMemory({ kind: 'fact', content: 'Options scope' }, 'ai', undefined, { projectId: PROJECT_B })
    expect(memory.listMemories({ projectId: PROJECT_B })[0].content).toBe('Options scope')
  })

  it('emits refreshes without broadcasting project memory content in global toasts', () => {
    memory.saveMemory({ kind: 'fact', content: 'PRIVATE-TOAST-MARKER', projectId: PROJECT_A }, 'ai')
    expect(fixture.events).toEqual([{ event: 'memory:changed', payload: {} }])
    fixture.events = []
    memory.saveMemory({ kind: 'fact', content: 'GLOBAL-TOAST-MARKER' }, 'ai')
    expect(JSON.stringify(fixture.events)).toContain('GLOBAL-TOAST-MARKER')
  })

  it('loads only the selected project skill preferences into the real skill result', () => {
    const directory = join(fixture.directory, 'skills', 'test-skill')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), '---\nname: test-skill\ndescription: A test skill\n---\nUse the skill.')
    reloadSkills()
    memory.saveMemory({ kind: 'skill', skill: 'test-skill', content: 'GLOBAL-SKILL' }, 'user')
    memory.saveMemory({ kind: 'skill', skill: 'test-skill', content: 'PROJECT-A-SKILL', projectId: PROJECT_A }, 'user')
    memory.saveMemory({ kind: 'skill', skill: 'test-skill', content: 'PROJECT-B-SKILL', projectId: PROJECT_B }, 'user')
    expect(memory.skillPreferences('test-skill')).toEqual(['GLOBAL-SKILL'])
    const skill = loadSkill('test-skill', true, { projectId: PROJECT_A })
    expect(skill).toContain('PROJECT-A-SKILL')
    expect(skill).not.toContain('PROJECT-B-SKILL')
    expect(skill).not.toContain('GLOBAL-SKILL')
  })

  it('promotes every project row idempotently without overwriting global keyed memories', () => {
    const global = memory.saveMemory({ kind: 'episode', key: 'conv:shared', content: 'Global episode' }, 'ai')
    const scoped = memory.saveMemory({ kind: 'episode', key: 'conv:shared', content: 'Project episode', projectId: PROJECT_A }, 'ai')
    memory.saveMemory({ kind: 'fact', content: 'Project fact', projectId: PROJECT_A }, 'ai')
    memory.saveMemory({ kind: 'fact', content: 'Other project', projectId: PROJECT_B }, 'ai')
    expect(memory.promoteProjectMemories(PROJECT_A)).toBe(2)
    expect(memory.promoteProjectMemories(PROJECT_A)).toBe(0)
    expect(memory.getMemory(global.id)).toMatchObject({ key: 'conv:shared', content: 'Global episode', projectId: null })
    expect(memory.getMemory(scoped.id)).toMatchObject({ key: `promoted:${scoped.id}`, content: 'Project episode', projectId: null })
    expect(memory.listMemories()).toHaveLength(3)
    expect(memory.listMemories({ projectId: PROJECT_B })).toHaveLength(1)
  })

  it('deletes only the selected project memories, including archived rows', () => {
    memory.saveMemory({ kind: 'fact', content: 'Global fact' }, 'user')
    memory.saveMemory({ kind: 'fact', content: 'Project active', projectId: PROJECT_A }, 'user')
    memory.saveMemory({ kind: 'fact', content: 'Project archived', projectId: PROJECT_A, status: 'archived' }, 'user')
    memory.saveMemory({ kind: 'fact', content: 'Other project', projectId: PROJECT_B }, 'user')
    expect(memory.deleteProjectMemories(PROJECT_A)).toBe(2)
    expect(memory.deleteProjectMemories(PROJECT_A)).toBe(0)
    expect(memory.listMemories()).toHaveLength(1)
    expect(memory.listMemories({ projectId: PROJECT_B })).toHaveLength(1)
    expect((profileDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(2)
  })
})
