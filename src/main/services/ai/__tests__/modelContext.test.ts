import { expect, it } from 'vitest'
import { resolveCaps, type ModelCapsOverride } from '@shared/ai'
import { contextLimitFromError, withContextWindowRetry } from '../modelContext'

it.each([
  ['deepseek-flash', 'deepseek', 1000000, 'builtin'],
  ['deepseek-v4-pro', 'deepseek', 1000000, 'builtin'],
  ['MiniMax-M3.1-Flash-Preview', 'custom', 1000000, 'builtin'],
  ['MINIMAX-m3.1-flash', 'custom', 1000000, 'builtin'],
  ['gpt-4.1', 'openai', 128000, 'builtin'],
  ['controlled-model', 'custom', 65536, 'default'],
  ['deepseek-r1:latest', 'ollama', 8192, 'default']
] as const)('uses a budget fallback for %s under %s', (model, kind, context, contextSource) => {
  expect(resolveCaps(model, {}, kind)).toMatchObject({ context, contextSource, auto: { context } })
})

it('resolves manual > reported > learned > built-in and exposes the automatic value', () => {
  const override: ModelCapsOverride = { context: 32768, reportedContext: 200000, learnedContext: 64000 }
  expect(resolveCaps('deepseek-flash', { 'deepseek-flash': override })).toMatchObject({
    context: 32768,
    contextSource: 'manual',
    auto: { context: 200000, contextSource: 'provider' }
  })
  delete override.context
  expect(resolveCaps('deepseek-flash', { 'deepseek-flash': override })).toMatchObject({ context: 200000, contextSource: 'provider' })
  delete override.reportedContext
  expect(resolveCaps('deepseek-flash', { 'deepseek-flash': override })).toMatchObject({ context: 64000, contextSource: 'error' })
  delete override.learnedContext
  expect(resolveCaps('deepseek-flash', { 'deepseek-flash': override }).context).toBe(1000000)
})

it.each([0, -1, NaN, Infinity, 1.5])('ignores invalid persisted context %s', (context) => {
  expect(resolveCaps('unknown', { unknown: { context, reportedContext: context, learnedContext: context } }).context).toBe(65536)
})

it.each([
  ['maximum context length is 32,768 tokens, requested 40000', 32768],
  ['This model supports at most 65536 tokens', 65536],
  ['input length exceeds the maximum context window of 128000 tokens', 128000],
  ['maximum output tokens is 8192', null],
  ['429 rate limit exceeded, retry in 64 seconds', null],
  ['context length exceeded (request 20000)', null]
])('learns only an explicit context ceiling: %s', (message, limit) => {
  expect(contextLimitFromError(new Error(message))).toBe(limit)
})

it('rebuilds a rejected request once with the learned budget', async () => {
  const sent: number[] = [],
    learned: number[] = []
  const result = await withContextWindowRetry(
    async (context) => {
      sent.push(context)
      if (context > 32768) throw new Error('maximum context length is 32768 tokens')
      return 'answer from the smaller evidence'
    },
    {
      context: 1000000,
      learn: (limit) => {
        learned.push(limit)
      }
    }
  )
  expect(result).toBe('answer from the smaller evidence')
  expect(sent).toEqual([1000000, 32768])
  expect(learned).toEqual([32768])
})

it('never retries a second overflow, an aborted/started turn, or an unrelated failure', async () => {
  for (const [message, allowed, expected] of [
    ['maximum context length is 32768 tokens', true, 2],
    ['maximum context length is 32768 tokens', false, 1],
    ['service unavailable', true, 1]
  ] as const) {
    let attempts = 0
    await expect(
      withContextWindowRetry(
        async () => {
          attempts++
          throw new Error(message)
        },
        { context: 1000000, learn: () => {}, canRetry: () => allowed }
      )
    ).rejects.toThrow(message)
    expect(attempts).toBe(expected)
  }
})
