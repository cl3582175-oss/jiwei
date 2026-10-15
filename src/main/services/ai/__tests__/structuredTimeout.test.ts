import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV4 } from 'ai/test'
import { args, f, stream, success } from './structuredFixture'
import { structured } from '../structured'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fakeTimeoutSignal() {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const c = new AbortController()
    setTimeout(() => c.abort(new DOMException('Timed out', 'TimeoutError')), ms)
    return c.signal
  })
}
function delayed(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

it('推理增量持续超过90秒时仍继续，不触发总时长中断', async () => {
  vi.useFakeTimers()
  fakeTimeoutSignal()
  f.model = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      await delayed(120_000, opts.abortSignal)
      return {
        content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'submit', input: '{"ok":true}' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: []
      }
    },
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(c) {
          c.enqueue({ type: 'reasoning-start', id: 'r' })
          for (let i = 0; i < 4; i++) {
            await new Promise((r) => setTimeout(r, 30_000))
            c.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'thinking' })
          }
          c.enqueue({ type: 'reasoning-end', id: 'r' })
          for (const part of success) c.enqueue(part)
          c.close()
        }
      })
    })
  })
  const result = structured({ ...args(), schema: z.object({ ok: z.boolean() }) })
  const outcome = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.advanceTimersByTimeAsync(125_000)
  expect(await outcome).toEqual({ value: { ok: true } })
  expect(f.model.doStreamCalls).toHaveLength(1)
})

it('首片后60秒无输出则中断，JSON回退取得独立的首片计时', async () => {
  vi.useFakeTimers()
  fakeTimeoutSignal()
  let firstSignal: AbortSignal | undefined
  f.model = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      firstSignal ??= opts.abortSignal
      await delayed(150_000, opts.abortSignal)
      return {
        content: [{ type: 'text', text: '{"ok":true}' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: []
      }
    },
    doStream: async (opts) => {
      if (f.model!.doStreamCalls.length === 1) {
        firstSignal = opts.abortSignal
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(c) {
              c.enqueue({ type: 'reasoning-start', id: 'r' })
              c.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'thinking' })
              opts.abortSignal?.addEventListener('abort', () => c.error(opts.abortSignal!.reason), { once: true })
            }
          })
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100_000))
      if (opts.abortSignal?.aborted) throw opts.abortSignal.reason
      return {
        stream: stream([
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: '{"ok":true}' },
          { type: 'text-end', id: 'text' },
          success[1]
        ])
      }
    }
  })
  const result = structured({ ...args(), schema: z.object({ ok: z.boolean() }) })
  const outcome = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.advanceTimersByTimeAsync(60_001)
  expect(firstSignal?.aborted).toBe(true)
  expect(f.model.doStreamCalls).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(100_000)
  expect(await outcome).toEqual({ value: { ok: true } })
})
