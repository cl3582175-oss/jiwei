import { expect, it, vi } from 'vitest'
import { generateText } from 'ai'
const f = vi.hoisted(() => ({
  fallback: vi.fn(async () => {
    throw new Error('Unexpected unguarded transport')
  })
}))
vi.mock('electron', () => ({ net: { fetch: f.fallback } }))
vi.mock('../providers', () => ({
  getProviderRow: () => ({ kind: 'openai', name: 'Synthetic', baseUrl: 'http://127.0.0.1/v1', sendEffort: false }),
  decryptKey: () => 'synthetic-test-key'
}))
vi.mock('../../agent/usage', () => ({ checkBudget: () => {}, recordUsage: () => {} }))
vi.mock('../../agent/context', () => ({ currentRun: () => null }))
import { buildModel } from '../model'
it('passes a per-request guarded transport into the provider SDK', async () => {
  const transport = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 1,
          model: 'vision',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Transport result' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  )
  const model = buildModel({ providerId: 'test', model: 'vision', effort: 'off', fetch: transport })
  const result = await generateText({ model: model.model, maxRetries: 0, prompt: 'Transport test' })
  expect(result.text).toBe('Transport result')
  expect(transport).toHaveBeenCalledTimes(1)
  expect(f.fallback).not.toHaveBeenCalled()
})
