import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import * as schema from '../../../db/knowledgeSchema'
import { ProviderInputSchema } from '@shared/schemas'

const state = vi.hoisted(() => ({ db: null as DB | null, sqlite: null as Database.Database | null, fetch: vi.fn() }))
vi.mock('../../../db', () => ({ getDb: () => state.db, getSqlite: () => state.sqlite }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  net: {
    fetch: (...args: unknown[]) => state.fetch(...args)
  },
  safeStorage: {
    decryptString: () => {
      throw new Error('No credentials are present in the fixtures')
    }
  }
}))
vi.mock('electron-log/main', () => ({ default: { error: vi.fn() } }))
vi.mock('../../device', () => ({ deviceId: () => 'fixture' }))
import { capsFor, fetchModels, testProvider, learnContextLimit, getProviderRow, listProviders, saveProvider } from '../providers'

beforeEach(() => {
  state.fetch.mockReset()
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

describe('context discovery and persistence', () => {
  it('validates manual context and restores automatic without erasing reported metadata', async () => {
    const saved = saveProvider(
      ProviderInputSchema.parse({ kind: 'custom', baseUrl: 'http://127.0.0.1:9000/v1', modelCaps: { sample: { context: 32768 } } })
    )
    expect(capsFor(saved.id, 'sample')).toMatchObject({ context: 32768, contextSource: 'manual' })
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'sample', context_window: 200000 }] })))
    await fetchModels(saved.id)
    saveProvider(ProviderInputSchema.parse({ id: saved.id, kind: 'custom', modelCaps: {} }))
    expect(capsFor(saved.id, 'sample')).toMatchObject({ context: 200000, contextSource: 'provider' })
    for (const context of [0, -1, 1.5, '32768', null])
      expect(
        ProviderInputSchema.safeParse({ kind: 'custom', baseUrl: 'http://127.0.0.1:9000/v1', modelCaps: { sample: { context } } }).success
      ).toBe(false)
  })
  it.each(['context_length', 'context_window', 'max_context_length', 'inputTokenLimit', 'max_input_tokens'])(
    'persists %s from model discovery and exposes it through the real capability resolver',
    async (field) => {
      const p = saveProvider({ kind: 'custom', baseUrl: 'http://127.0.0.1:9000/v1' })
      state.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'sample', [field]: 196608 }] })))
      expect(await fetchModels(p.id)).toEqual(['sample'])
      expect(capsFor(p.id, 'sample')).toMatchObject({ context: 196608, contextSource: 'provider' })
      expect(listProviders()[0].modelCaps.sample.reportedContext).toBe(196608)
    }
  )
  it('reads Gemini-style limits during connection tests without resetting the selected list or manual override', async () => {
    const p = saveProvider({ kind: 'google', models: ['kept'], modelCaps: { sample: { context: 32000 } } })
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'models/sample', inputTokenLimit: 1000000 }] })))
    expect((await testProvider(p.id)).ok).toBe(true)
    expect(listProviders()[0].models).toEqual(['kept'])
    expect(capsFor(p.id, 'sample')).toMatchObject({ context: 32000, auto: { context: 1000000 } })
  })
  it('uses Ollama /api/show num_ctx instead of the conservative fallback', async () => {
    const p = saveProvider({ kind: 'ollama' })
    state.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'local-sample' }] }))
      expect(url).toBe('http://127.0.0.1:11434/api/show')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'local-sample' })
      return new Response(JSON.stringify({ parameters: 'temperature 0.2\nnum_ctx 32768', model_info: { 'llama.context_length': 131072 } }))
    })
    await fetchModels(p.id)
    expect(capsFor(p.id, 'local-sample')).toMatchObject({ context: 32768, contextSource: 'provider' })
  })
  it('remembers an explicit error limit and invalidates only a contradicted larger provider report', async () => {
    const p = saveProvider({ kind: 'custom', baseUrl: 'http://127.0.0.1:9000/v1', modelCaps: { sample: { vision: true } } })
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'sample', context_length: 200000 }] })))
    await fetchModels(p.id)
    learnContextLimit(p.id, 'sample', 32768)
    expect(capsFor(p.id, 'sample')).toMatchObject({ context: 32768, contextSource: 'error', vision: true })
    expect(listProviders()[0].modelCaps.sample.learnedContext).toBe(32768)
    saveProvider({ id: p.id, kind: 'custom', modelCaps: { sample: { context: 16000 } } })
    expect(capsFor(p.id, 'sample')).toMatchObject({ context: 16000, auto: { context: 32768 } })
  })
  it('keeps a model usable when metadata is absent or Ollama show is unavailable', async () => {
    const p = saveProvider({ kind: 'ollama' })
    state.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'local-sample', context_length: -5 }] }))
      return new Response('', { status: 404 })
    })
    expect(await fetchModels(p.id)).toEqual(['local-sample'])
    expect(capsFor(p.id, 'local-sample')).toMatchObject({ context: 8192, contextSource: 'default' })
  })
})
