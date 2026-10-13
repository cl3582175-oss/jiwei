import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import * as schema from '../../../db/knowledgeSchema'
import { ProviderInputSchema } from '@shared/schemas'

const state = vi.hoisted(() => ({ db: null as DB | null, sqlite: null as Database.Database | null }))
vi.mock('../../../db', () => ({ getDb: () => state.db, getSqlite: () => state.sqlite }))
vi.mock('electron', () => ({
  net: {
    fetch: () => {
      throw new Error('Capability settings must not call a provider')
    }
  },
  safeStorage: {
    decryptString: () => {
      throw new Error('No credentials are present in the fixtures')
    }
  }
}))
vi.mock('electron-log/main', () => ({ default: { error: vi.fn() } }))
vi.mock('../../device', () => ({ deviceId: () => 'fixture' }))
import { capsFor, getProviderRow, listProviders, saveProvider } from '../providers'

beforeEach(() => {
  state.sqlite = new Database(':memory:')
  state.sqlite.loadExtension(getLoadablePath())
  state.db = drizzle(state.sqlite, { schema })
  migrate(state.db, { migrationsFolder: 'resources/migrations' })
})
afterEach(() => {
  state.sqlite?.close()
  state.db = null
  state.sqlite = null
})

describe('tool reliability provider input and persistence', () => {
  it.each([false, true])('retains a boolean tools override through IPC schema, save, SQLite and capsFor (%s)', (tools) => {
    const input = ProviderInputSchema.parse({ kind: 'ollama', models: ['controlled-model'], modelCaps: { 'controlled-model': { tools } } })
    expect(input.modelCaps).toEqual({ 'controlled-model': { tools } })
    const saved = saveProvider(input)
    expect(saved.modelCaps).toEqual({ 'controlled-model': { tools } })
    expect(JSON.parse(getProviderRow(saved.id).modelCaps)).toEqual({ 'controlled-model': { tools } })
    expect(listProviders()[0].modelCaps).toEqual({ 'controlled-model': { tools } })
    expect(capsFor(saved.id, 'controlled-model')).toMatchObject({ tools, auto: { tools: true } })
    expect(capsFor(saved.id, 'other-model')).toMatchObject({ tools: true, auto: { tools: true } })
  })
  it('returns to automatic tools reliability after removing only that override and preserves other caps', () => {
    const first = saveProvider(
      ProviderInputSchema.parse({
        kind: 'ollama',
        models: ['controlled-model'],
        modelCaps: { 'controlled-model': { tools: false, vision: true, tier: 'strong' }, other: { vision: false } }
      })
    )
    expect(capsFor(first.id, 'controlled-model').tools).toBe(false)
    const second = saveProvider(
      ProviderInputSchema.parse({
        id: first.id,
        kind: 'ollama',
        modelCaps: { 'controlled-model': { vision: true, tier: 'strong' }, other: { vision: false } }
      })
    )
    expect(second.modelCaps).toEqual({ 'controlled-model': { vision: true, tier: 'strong' }, other: { vision: false } })
    expect(capsFor(first.id, 'controlled-model')).toMatchObject({ tools: true, vision: true, tier: 'strong', auto: { tools: true } })
    saveProvider(ProviderInputSchema.parse({ id: first.id, kind: 'ollama', modelCaps: {} }))
    expect(getProviderRow(first.id).modelCaps).toBe('{}')
    expect(capsFor(first.id, 'controlled-model')).toMatchObject({ tools: true, vision: false, tier: 'basic' })
  })
  it.each(['false', 0, null, {}])('rejects a nonboolean tools override %s at the schema boundary', (tools) => {
    expect(ProviderInputSchema.safeParse({ kind: 'ollama', modelCaps: { 'controlled-model': { tools } } }).success).toBe(false)
  })
  it('keeps legacy provider settings valid and gives them automatic reliable tools', () => {
    const saved = saveProvider(ProviderInputSchema.parse({ kind: 'ollama', modelCaps: { 'controlled-model': { vision: true } } }))
    expect(saved.modelCaps).toEqual({ 'controlled-model': { vision: true } })
    expect(capsFor(saved.id, 'controlled-model')).toMatchObject({ tools: true, vision: true, auto: { tools: true } })
    expect(capsFor(null, 'controlled-model')).toMatchObject({ tools: true, auto: { tools: true } })
  })
})
