import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  mode: 'cloud' as 'cloud' | 'local',
  fetch: vi.fn(),
  local: vi.fn()
}))
vi.mock('electron', () => ({ net: { fetch: fixture.fetch } }))
vi.mock('electron-log/main', () => ({ default: { error: vi.fn() } }))
vi.mock('../../settings', () => ({
  getSettings: () => ({ ai: { embedding: { mode: fixture.mode, providerId: 'fixture', model: 'fixture' } } })
}))
vi.mock('../../../events', () => ({ emit: vi.fn() }))
vi.mock('../providers', () => ({ getProviderRow: () => ({ baseUrl: 'https://fixture.invalid/v1' }), decryptKey: () => '' }))
vi.mock('../localEmbedding', () => ({ embedRaw: fixture.local }))
import { embed } from '../embedding'

beforeEach(() => {
  fixture.mode = 'cloud'
  fixture.fetch.mockReset().mockImplementation(async (_url, init) => {
    const inputs = JSON.parse(init.body).input as string[]
    return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, 0] })) })
  })
  fixture.local.mockReset().mockImplementation(async (inputs: string[]) => inputs.map(() => [1, 0]))
})

describe('web embedding send guard', () => {
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
        return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, 0] })) })
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
    expect(result).toEqual(Array.from({ length: 33 }, () => [1, 0]))
  })
})
