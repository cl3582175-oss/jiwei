import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  mode: 'cloud' as 'cloud' | 'local',
  model: 'fixture',
  fetch: vi.fn(),
  local: vi.fn()
}))
vi.mock('electron', () => ({ net: { fetch: fixture.fetch } }))
vi.mock('electron-log/main', () => ({ default: { error: vi.fn() } }))
vi.mock('../../settings', () => ({
  getSettings: () => ({ ai: { embedding: { mode: fixture.mode, providerId: 'fixture', model: fixture.model } } })
}))
vi.mock('../../../events', () => ({ emit: vi.fn() }))
vi.mock('../providers', () => ({ getProviderRow: () => ({ baseUrl: 'https://fixture.invalid/v1' }), decryptKey: () => '' }))
vi.mock('../localEmbedding', () => ({ embedRaw: fixture.local }))
import { embed, getStatus, setStatus, refreshStatus } from '../embedding'

beforeEach(() => {
  fixture.mode = 'cloud'
  fixture.model = 'fixture'
  fixture.fetch.mockReset().mockImplementation(async (_url, init) => {
    const inputs = JSON.parse(init.body).input as string[]
    return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, ...Array(511).fill(0)] })) })
  })
  fixture.local.mockReset().mockImplementation(async (inputs: string[]) => inputs.map(() => [1, 0]))
})

describe('web embedding send guard', () => {
  it('rejects cloud dimensions before MRL truncation can disguise an incompatible model', async () => {
    fixture.fetch.mockResolvedValue(Response.json({ data: [{ index: 0, embedding: Array(768).fill(0) }] }))
    await expect(embed(['合成资料'], 'doc')).rejects.toThrow(/768/)
  })
  it('rejects before any cloud request when current privacy denies the candidate', async () => {
    const denied = new Error('Controlled privacy denial')
    await expect(
      embed(['private'], 'doc', undefined, () => {
        throw denied
      })
    ).rejects.toBe(denied)
    expect(fixture.fetch).not.toHaveBeenCalled()
  })

  it.each(['cloud', 'local'] as const)('stops subsequent %s batches after privacy changes during the first batch', async (mode) => {
    fixture.mode = mode
    let allowed = true
    const guard = () => {
      if (!allowed) throw new Error('Controlled privacy denial')
    }
    if (mode === 'cloud') {
      fixture.fetch.mockImplementation(async (_url, init) => {
        allowed = false
        const inputs = JSON.parse(init.body).input as string[]
        return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, ...Array(511).fill(0)] })) })
      })
    } else
      fixture.local.mockImplementation(async (inputs: string[]) => {
        allowed = false
        return inputs.map(() => [1, 0])
      })
    await expect(
      embed(
        Array.from({ length: 33 }, (_, i) => `passage-${i}`),
        'doc',
        undefined,
        guard
      )
    ).rejects.toThrow('Controlled privacy denial')
    expect(mode === 'cloud' ? fixture.fetch : fixture.local).toHaveBeenCalledTimes(1)
  })

  it('preserves unguarded batching and normalization for existing callers', async () => {
    const result = await embed(
      Array.from({ length: 33 }, (_, i) => `passage-${i}`),
      'doc'
    )
    expect(fixture.fetch).toHaveBeenCalledTimes(3)
    expect(result).toEqual(Array.from({ length: 33 }, () => [1, ...Array(511).fill(0)]))
  })
})

it('dimension errors survive status refresh until model changes or explicit retry', async () => {
  setStatus({ state: 'error', message: 'Embedding model returned768dimensions' })
  await refreshStatus()
  expect(getStatus()).toMatchObject({ state: 'error', message: 'Embedding model returned768dimensions' })
  fixture.model = 'compatible'
  await refreshStatus()
  expect(getStatus()).toMatchObject({ state: 'ready', message: null })
  setStatus({ state: 'error', message: 'retryable error' })
  await refreshStatus(true)
  expect(getStatus()).toMatchObject({ state: 'ready', message: null })
})
