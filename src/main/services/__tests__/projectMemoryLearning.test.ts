import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq, getTableColumns, getTableName } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blocks, chatProjects, conversationAttachments, conversations, messages, notes, projectSources, sources } from '../../db/schema'
import type { Proposal } from '@shared/types'

type ExtractOutput = {
  memories: { op: 'add' | 'update' | 'invalidate'; ref?: string; kind?: 'fact'; content?: string; quote?: string }[]
  reinforced?: string[]
  concepts: { name: string; signal: 'asked' | 'confused' | 'understood'; note?: string }[]
  episode: string | null
}
const fixture = vi.hoisted(() => ({
  directory: '',
  sql: null as Database.Database | null,
  db: null as BetterSQLite3Database | null,
  events: [] as { event: string; payload: unknown }[],
  requests: [] as { prompt: string }[],
  output: { memories: [], concepts: [], episode: null } as ExtractOutput | { preferences: { content: string }[] },
  duringRequest: null as (() => void) | null
}))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.directory, getAppPath: () => process.cwd(), isPackaged: false },
  dialog: {},
  shell: {}
}))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {} } }))
vi.mock('../../db', () => ({ getDb: () => fixture.db, getSqlite: () => fixture.sql }))
vi.mock('../../events', () => ({ emit: (event: string, payload: unknown) => fixture.events.push({ event, payload }) }))
vi.mock('../settings', () => ({
  getSettings: () => ({ language: 'zh-CN', ai: { chat: { providerId: 'controlled', model: 'test-model' } } }),
  setSettings: () => {}
}))
vi.mock('../docs', () => ({ listBlocks: (noteId: string) => fixture.db!.select().from(blocks).where(eq(blocks.noteId, noteId)).all() }))
vi.mock('../plugins/registry', () => ({ pluginRegistryRevision: () => 0, enabledPlugins: () => [] }))
vi.mock('../ai/providers', () => ({ getProviderRow: () => ({ modelCaps: '{}', models: '["test-model"]' }) }))
// Keep the extractor, structured schema validation, memory/learner services, Drizzle and SQLite real.
// Only the outbound model request is replaced; no provider or user data can be reached.
vi.mock('../ai/request', () => ({
  createModelRequest: (request: { prompt: string }) => {
    fixture.requests.push(request)
    return {
      generate: async () => {
        fixture.duringRequest?.()
        return { toolCalls: [{ toolName: 'submit', input: fixture.output }], text: JSON.stringify(fixture.output) }
      },
      diagnostics: () => ({}),
      state: {}
    }
  },
  logModelFailure: () => {},
  ModelOutputTruncated: class extends Error {}
}))

import { closeProfileDb, profileDb } from '../../db/profile'
import { induceSkillPreferences, learnFromConversation, recordProposalDecision, reviewFeedback } from '../memoryLearn'
import {
  deleteProjectMemories,
  getMemory,
  listMemories,
  promoteProjectMemories,
  saveMemory,
  setUserProfile,
  skillPreferences,
  userCard
} from '../memory'
import { learnerNote, listConcepts, recordConcept } from '../learner'
import { conversationProject, memoryProjectId } from '../ai/memoryScope'

const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'
const DEFAULT_PROJECT = '33333333-3333-4333-8333-333333333333'

function conversation(id: string, projectId: string | null): void {
  fixture
    .db!.insert(conversations)
    .values({ id, projectId, title: `Title ${id}`, createdAt: 1, updatedAt: 1 })
    .run()
  fixture
    .db!.insert(messages)
    .values({ id: `${id}-user`, conversationId: id, role: 'user', content: 'Study project material', createdAt: 1, updatedAt: 1 })
    .run()
  fixture
    .db!.insert(messages)
    .values({ id: `${id}-reply`, conversationId: id, role: 'assistant', content: 'A reply', createdAt: 2, updatedAt: 2 })
    .run()
}

function proposal(projectId: string | null, text: string): Proposal {
  return {
    id: 'proposal',
    noteId: 'note',
    title: 'Test',
    skill: 'test-skill',
    auto: false,
    createdAt: 1,
    ops: [{ op: 'insert_after', blockId: 'block', nodes: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }],
    embeds: {},
    opStatus: ['rejected'],
    status: 'resolved',
    sources: null,
    model: null,
    memoryProjectId: projectId
  }
}

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'jiwei-project-learning-'))
  fixture.sql = new Database(':memory:')
  for (const table of [blocks, chatProjects, conversations, messages, conversationAttachments, notes, projectSources, sources]) {
    fixture.sql.exec(
      `CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
        .map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`)
        .join(', ')})`
    )
  }
  fixture.db = drizzle(fixture.sql)
  fixture.db.insert(notes).values({ id: 'note', title: 'Public note', learnedAt: 1, editedAt: 1, createdAt: 1, updatedAt: 1 }).run()
  for (const [id, memory] of [
    [PROJECT_A, 'project'],
    [PROJECT_B, 'project'],
    [DEFAULT_PROJECT, 'default']
  ] as const) {
    fixture.db.insert(chatProjects).values({ id, name: id, memory, createdAt: 1, updatedAt: 1 }).run()
  }
  fixture.events = []
  fixture.requests = []
  fixture.output = { memories: [], concepts: [], episode: null }
  fixture.duringRequest = null
})
afterEach(() => {
  closeProfileDb()
  fixture.sql?.close()
  rmSync(fixture.directory, { recursive: true, force: true })
})

describe('project-scoped learning', () => {
  it('resolves only live project membership and leaves ordinary and default-memory conversations global', () => {
    conversation('a', PROJECT_A)
    conversation('ordinary', null)
    conversation('default', DEFAULT_PROJECT)
    expect(memoryProjectId('a')).toBe(PROJECT_A)
    expect(conversationProject('a')?.name).toBe(PROJECT_A)
    expect(memoryProjectId('ordinary')).toBeNull()
    expect(memoryProjectId('default')).toBeNull()
    expect(conversationProject('default')?.id).toBe(DEFAULT_PROJECT)
    expect(conversationProject('missing')).toBeNull()
    fixture.db!.update(chatProjects).set({ deletedAt: 10 }).where(eq(chatProjects.id, PROJECT_A)).run()
    expect(conversationProject('a')).toBeNull()
    expect(memoryProjectId('a')).toBeNull()
  })

  it('does not extract dangling project conversations or soft-deleted conversations', async () => {
    conversation('a', PROJECT_A)
    conversation('deleted', null)
    fixture.db!.update(chatProjects).set({ deletedAt: 10 }).where(eq(chatProjects.id, PROJECT_A)).run()
    fixture.db!.update(conversations).set({ deletedAt: 10 }).where(eq(conversations.id, 'deleted')).run()
    expect(await learnFromConversation('a')).toEqual({ added: 0, concepts: 0, episode: false })
    expect(await learnFromConversation('deleted')).toEqual({ added: 0, concepts: 0, episode: false })
    expect(fixture.requests).toEqual([])
  })

  it('uses only project candidates and episodes, persists learned content locally, and redacts global concept evidence', async () => {
    conversation('a', PROJECT_A)
    setUserProfile({ avoid: 'PROFILE-AVOID' })
    saveMemory({ kind: 'fact', content: 'GLOBAL-CANDIDATE' }, 'ai')
    saveMemory({ kind: 'fact', content: 'PROJECT-A-CANDIDATE', projectId: PROJECT_A }, 'ai')
    saveMemory({ kind: 'fact', content: 'PROJECT-B-CANDIDATE', projectId: PROJECT_B }, 'ai')
    saveMemory({ kind: 'episode', key: 'conv:a', content: 'GLOBAL-EPISODE' }, 'ai')
    saveMemory({ kind: 'episode', key: 'conv:a', content: 'PROJECT-A-EPISODE', projectId: PROJECT_A }, 'ai')
    fixture.output = {
      memories: [{ op: 'add', kind: 'fact', content: 'PROJECT-A-LEARNED', quote: 'PROJECT-A-QUOTE' }],
      concepts: [{ name: '条件概率', signal: 'confused', note: 'PROJECT-A-CONCEPT-SECRET' }],
      episode: 'PROJECT-A-NEW-EPISODE'
    }
    fixture.events = []
    expect(await learnFromConversation('a')).toEqual({ added: 1, concepts: 1, episode: true })
    const prompt = fixture.requests[0].prompt
    expect(prompt).toContain('PROFILE-AVOID')
    expect(prompt).toContain('PROJECT-A-CANDIDATE')
    expect(prompt).toContain('PROJECT-A-EPISODE')
    expect(prompt).not.toContain('GLOBAL-')
    expect(prompt).not.toContain('PROJECT-B-')
    expect(listMemories({ projectId: PROJECT_A }).map((row) => row.content)).toEqual(
      expect.arrayContaining(['PROJECT-A-LEARNED', 'PROJECT-A-NEW-EPISODE'])
    )
    expect(userCard(true)).not.toContain('PROJECT-A-')
    expect(listConcepts()[0]).toMatchObject({ name: '条件概率', confused: 1, note: null })
    expect(learnerNote('条件概率', true)).not.toContain('PROJECT-A-CONCEPT-SECRET')
    expect(JSON.stringify(profileDb().prepare('SELECT evidence FROM concept_events').all())).not.toContain('PROJECT-A-CONCEPT-SECRET')
    expect(JSON.stringify(fixture.events)).not.toContain('PROJECT-A-')
    recordConcept('条件概率', 'confused', { conversationId: 'a', note: 'Duplicate private note' })
    expect(listConcepts()[0].confused).toBe(1)
  })

  it('keeps default-memory projects on the ordinary global learning path', async () => {
    conversation('default', DEFAULT_PROJECT)
    saveMemory({ kind: 'fact', content: 'GLOBAL-CANDIDATE' }, 'ai')
    saveMemory({ kind: 'fact', content: 'PROJECT-A-CANDIDATE', projectId: PROJECT_A }, 'ai')
    fixture.output = { memories: [{ op: 'add', kind: 'fact', content: 'GLOBAL-LEARNED' }], concepts: [], episode: 'GLOBAL-LEARNED-EPISODE' }
    expect(await learnFromConversation('default')).toEqual({ added: 1, concepts: 0, episode: true })
    expect(fixture.requests[0].prompt).toContain('GLOBAL-CANDIDATE')
    expect(fixture.requests[0].prompt).not.toContain('PROJECT-A-CANDIDATE')
    expect(listMemories().map((row) => row.content)).toEqual(expect.arrayContaining(['GLOBAL-LEARNED', 'GLOBAL-LEARNED-EPISODE']))
  })

  it('applies updates, invalidations, and reinforcement only to references in the current project', async () => {
    conversation('a', PROJECT_A)
    const global = saveMemory({ kind: 'fact', content: 'GLOBAL-UNCHANGED' }, 'ai')
    const b = saveMemory({ kind: 'fact', content: 'PROJECT-B-UNCHANGED', projectId: PROJECT_B }, 'ai')
    const a = saveMemory({ kind: 'fact', content: 'PROJECT-A-OLD', projectId: PROJECT_A, pinned: false }, 'ai')
    const archived = saveMemory({ kind: 'fact', content: 'PROJECT-A-INVALIDATE', projectId: PROJECT_A }, 'ai')
    profileDb().prepare('UPDATE memories SET use_count = 10 WHERE id = ?').run(a.id)
    fixture.output = {
      memories: [
        { op: 'update', ref: 'm1', content: 'PROJECT-A-UPDATED' },
        { op: 'invalidate', ref: 'm2' },
        { op: 'update', ref: 'm99', content: 'INVENTED' }
      ],
      reinforced: ['m1', 'm99'],
      concepts: [],
      episode: null
    }
    await learnFromConversation('a')
    expect(getMemory(a.id)).toMatchObject({ content: 'PROJECT-A-UPDATED', projectId: PROJECT_A, useCount: 11 })
    expect(getMemory(archived.id)?.status).toBe('archived')
    expect(getMemory(global.id)?.content).toBe('GLOBAL-UNCHANGED')
    expect(getMemory(b.id)?.content).toBe('PROJECT-B-UNCHANGED')
  })

  it.each(['project deleted', 'conversation deleted', 'conversation moved', 'mode changed'])(
    'discards extraction when %s while the model result is pending',
    async (change) => {
      conversation('a', PROJECT_A)
      fixture.output = { memories: [{ op: 'add', kind: 'fact', content: 'STALE-SECRET' }], concepts: [], episode: 'STALE-EPISODE' }
      fixture.duringRequest = () => {
        if (change === 'project deleted')
          fixture.db!.update(chatProjects).set({ deletedAt: 10 }).where(eq(chatProjects.id, PROJECT_A)).run()
        if (change === 'conversation deleted')
          fixture.db!.update(conversations).set({ deletedAt: 10 }).where(eq(conversations.id, 'a')).run()
        if (change === 'conversation moved')
          fixture.db!.update(conversations).set({ projectId: PROJECT_B }).where(eq(conversations.id, 'a')).run()
        if (change === 'mode changed')
          fixture.db!.update(chatProjects).set({ memory: 'default' }).where(eq(chatProjects.id, PROJECT_A)).run()
      }
      expect(await learnFromConversation('a')).toEqual({ added: 0, concepts: 0, episode: false })
      expect(profileDb().prepare('SELECT content FROM memories').all()).toEqual([])
      expect(profileDb().prepare('SELECT * FROM extract_state').all()).toEqual([])
    }
  )

  it('uses project evidence only for mastery counters while preserving a prior global concept note', () => {
    conversation('global', null)
    conversation('a', PROJECT_A)
    recordConcept('条件概率', 'asked', { conversationId: 'global', note: 'GLOBAL-CONCEPT-NOTE' })
    recordConcept('条件概率', 'confused', { conversationId: 'a', note: 'PRIVATE-CONCEPT-NOTE' })
    expect(listConcepts()[0]).toMatchObject({ asked: 1, confused: 1, note: 'GLOBAL-CONCEPT-NOTE' })
    expect(JSON.stringify(profileDb().prepare('SELECT evidence FROM concept_events').all())).not.toContain('PRIVATE-CONCEPT-NOTE')
  })

  it('keeps rejected proposal samples and induced skill preferences within their originating scope', async () => {
    for (let index = 0; index < 3; index++) recordProposalDecision(proposal(PROJECT_A, 'PROJECT-A-SAMPLE'), 0, 'rejected')
    fixture.output = { preferences: [{ content: 'PROJECT-A-SKILL-LEARNED' }] }
    const learned = await induceSkillPreferences()
    expect(learned).toHaveLength(1)
    expect(learned[0].projectId).toBe(PROJECT_A)
    expect(skillPreferences('test-skill')).toEqual([])
    expect(skillPreferences('test-skill', { projectId: PROJECT_A })).toEqual(['PROJECT-A-SKILL-LEARNED'])
    expect(profileDb().prepare('SELECT DISTINCT project_id FROM skill_feedback').all()).toEqual([{ project_id: PROJECT_A }])
    expect(JSON.stringify(fixture.events)).not.toContain('PROJECT-A-SKILL-LEARNED')
  })

  it('does not pool skill samples across scopes or include other scopes in the induction prompt', async () => {
    saveMemory({ kind: 'skill', skill: 'test-skill', content: 'GLOBAL-SKILL-EXISTING' }, 'ai')
    saveMemory({ kind: 'skill', skill: 'test-skill', content: 'A-SKILL-EXISTING', projectId: PROJECT_A }, 'ai')
    saveMemory({ kind: 'skill', skill: 'test-skill', content: 'B-SKILL-EXISTING', projectId: PROJECT_B }, 'ai')
    for (let index = 0; index < 2; index++) {
      recordProposalDecision(proposal(null, 'GLOBAL-SAMPLE'), 0, 'rejected')
      recordProposalDecision(proposal(PROJECT_A, 'A-PRIVATE-SAMPLE'), 0, 'rejected')
      recordProposalDecision(proposal(PROJECT_B, 'B-PRIVATE-SAMPLE'), 0, 'rejected')
    }
    expect(await induceSkillPreferences()).toEqual([])
    expect(fixture.requests).toEqual([])
    recordProposalDecision(proposal(PROJECT_A, 'A-PRIVATE-SAMPLE'), 0, 'rejected')
    fixture.output = { preferences: [{ content: 'A-SKILL-LEARNED' }] }
    expect(await induceSkillPreferences()).toHaveLength(1)
    expect(fixture.requests[0].prompt).toContain('A-PRIVATE-SAMPLE')
    expect(fixture.requests[0].prompt).toContain('A-SKILL-EXISTING')
    expect(fixture.requests[0].prompt).not.toContain('B-')
    expect(fixture.requests[0].prompt).not.toContain('GLOBAL-')
    expect((profileDb().prepare('SELECT COUNT(*) AS n FROM skill_feedback WHERE consumed_at IS NULL').get() as { n: number }).n).toBe(4)
  })

  it.each(['deleted', 'promoted'])('discards an induced preference if its project is %s during the request', async (change) => {
    for (let index = 0; index < 3; index++) recordProposalDecision(proposal(PROJECT_A, 'PRIVATE-SAMPLE'), 0, 'rejected')
    fixture.output = { preferences: [{ content: 'STALE-SKILL-PREFERENCE' }] }
    fixture.duringRequest = () => {
      if (change === 'deleted') {
        deleteProjectMemories(PROJECT_A)
        fixture.db!.update(chatProjects).set({ deletedAt: 10 }).where(eq(chatProjects.id, PROJECT_A)).run()
      } else {
        promoteProjectMemories(PROJECT_A)
        fixture.db!.update(chatProjects).set({ memory: 'default' }).where(eq(chatProjects.id, PROJECT_A)).run()
      }
    }
    expect(await induceSkillPreferences()).toEqual([])
    expect(profileDb().prepare('SELECT content FROM memories').all()).toEqual([])
  })

  it('does not record proposal feedback from a currently private derived note', () => {
    fixture.db!.update(notes).set({ aiExcluded: true }).where(eq(notes.id, 'note')).run()
    recordProposalDecision(proposal(null, 'PROJECT-PRIVATE-OUTPUT'), 0, 'rejected')
    expect(profileDb().prepare('SELECT * FROM skill_feedback').all()).toEqual([])
  })

  it('discards pending feedback before reading a later private rewrite of the accepted block', () => {
    recordProposalDecision(proposal(null, 'PUBLIC-OUTPUT'), 0, 'accepted', ['block'])
    fixture
      .db!.insert(blocks)
      .values({
        id: 'block',
        noteId: 'note',
        kind: 'paragraph',
        section: 'body',
        rowId: null,
        position: 0,
        text: 'PROJECT-PRIVATE-REWRITE',
        hash: 'controlled',
        createdAt: 1,
        updatedAt: 2
      })
      .run()
    fixture.db!.update(notes).set({ aiExcluded: true }).where(eq(notes.id, 'note')).run()

    expect(reviewFeedback(Date.now(), true)).toBe(0)
    const sample = profileDb().prepare('SELECT kind,before,after,consumed_at FROM skill_feedback').get()
    expect(sample).toMatchObject({ kind: 'lost', before: '', after: null, consumed_at: expect.any(Number) })
    expect(JSON.stringify(sample)).not.toContain('PROJECT-PRIVATE')
  })

  it.each([null, PROJECT_A])('discards already edited feedback after its note becomes private in memory scope %s', async (projectId) => {
    for (let index = 0; index < 3; index++) recordProposalDecision(proposal(projectId, 'PUBLIC-OUTPUT'), 0, 'rejected')
    profileDb().prepare("UPDATE skill_feedback SET kind='edited',after='PROJECT-PRIVATE-REWRITE'").run()
    fixture.db!.update(notes).set({ aiExcluded: true }).where(eq(notes.id, 'note')).run()
    fixture.output = { preferences: [{ content: 'MUST-NOT-BE-LEARNED' }] }

    expect(await induceSkillPreferences()).toEqual([])
    expect(fixture.requests).toEqual([])
    expect(profileDb().prepare('SELECT COUNT(*) AS n FROM skill_feedback WHERE consumed_at IS NULL').get()).toEqual({ n: 0 })
    expect(JSON.stringify(profileDb().prepare('SELECT before,after FROM skill_feedback').all())).not.toContain('PROJECT-PRIVATE')
    expect(profileDb().prepare('SELECT content FROM memories').all()).toEqual([])
  })

  it('induces from remaining public samples without sending samples of a private note', async () => {
    fixture.db!.insert(notes).values({ id: 'public', title: 'Public control', learnedAt: 1, editedAt: 1, createdAt: 1, updatedAt: 1 }).run()
    for (let index = 0; index < 3; index++) {
      recordProposalDecision(proposal(null, 'PROJECT-PRIVATE-SAMPLE'), 0, 'rejected')
      recordProposalDecision({ ...proposal(null, 'PUBLIC-SAMPLE'), noteId: 'public' }, 0, 'rejected')
    }
    fixture.db!.update(notes).set({ aiExcluded: true }).where(eq(notes.id, 'note')).run()
    fixture.output = { preferences: [{ content: 'PUBLIC-LEARNED-PREFERENCE' }] }

    expect(await induceSkillPreferences()).toHaveLength(1)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0].prompt).toContain('PUBLIC-SAMPLE')
    expect(fixture.requests[0].prompt).not.toContain('PROJECT-PRIVATE')
    expect(skillPreferences('test-skill')).toEqual(['PUBLIC-LEARNED-PREFERENCE'])
  })

  it('discards the induced result if its source note becomes private while the request is pending', async () => {
    for (let index = 0; index < 3; index++) recordProposalDecision(proposal(null, 'PUBLIC-SAMPLE'), 0, 'rejected')
    fixture.output = { preferences: [{ content: 'STALE-PRIVATE-PREFERENCE' }] }
    fixture.duringRequest = () => fixture.db!.update(notes).set({ aiExcluded: true }).where(eq(notes.id, 'note')).run()

    expect(await induceSkillPreferences()).toEqual([])
    expect(profileDb().prepare('SELECT content FROM memories').all()).toEqual([])
    expect(profileDb().prepare('SELECT COUNT(*) AS n FROM skill_feedback WHERE consumed_at IS NULL').get()).toEqual({ n: 0 })
  })
})
