import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
const mocks = vi.hoisted(() => ({ generate: vi.fn(), build: vi.fn(() => ({ model: 'test-model' })) }))
vi.mock('ai', () => ({ generateText: mocks.generate, tool: (value: unknown) => value }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('../../services/ai/model', () => ({ buildModel: mocks.build }))
vi.mock('../../services/ai/providers', () => ({ getProviderRow: vi.fn() }))
import { structured } from '../../services/ai/structured'

const opts = { providerId: 'test', model: 'test', system: 'task', prompt: 'untrusted image data', schema: z.object({ answer: z.string() }) }
beforeEach(() => {
  mocks.generate.mockReset()
  mocks.build.mockClear()
})
describe('structured privacy and image input', () => {
  it('rechecks privacy after a successful model call before returning', async () => {
    let allowed = true
    mocks.generate.mockImplementation(async () => {
      allowed = false
      return { toolCalls: [{ toolName: 'submit', input: { answer: 'late' } }] }
    })
    await expect(structured({ ...opts, guard: () => { if (!allowed) throw new Error('private now') } })).rejects.toThrow('private now')
    expect(mocks.generate).toHaveBeenCalledTimes(1)
  })
  it('sends image bytes with the same text task and requested reasoning effort', async () => {
    mocks.generate.mockResolvedValue({ toolCalls: [{ toolName: 'submit', input: { answer: 'ok' } }] })
    await structured({ ...opts, effort: 'high', images: [{ data: new Uint8Array([1, 2]), mediaType: 'image/png' }] })
    expect(mocks.build).toHaveBeenCalledWith({ providerId: 'test', model: 'test', effort: 'high' })
    expect(mocks.generate.mock.calls[0][0].messages).toEqual([{ role: 'user', content: [{ type: 'image', image: new Uint8Array([1, 2]), mediaType: 'image/png' }, { type: 'text', text: opts.prompt }] }])
    expect(mocks.generate.mock.calls[0][0].prompt).toBeUndefined()
  })
})
