import { afterEach, expect, it, vi } from 'vitest'
import { expect as playwrightExpect, type Page } from '@playwright/test'
import { askInApp } from './ragChat'
import { ChatSendSchema } from '../../src/shared/schemas'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const input = { providerId: 'provider', model: 'model', text: 'synthetic', scope: { type: 'none' as const } }
function timeoutPage(statuses: string[]): Page {
  vi.spyOn(playwrightExpect, 'poll').mockReturnValue({
    toBe: async () => {
      throw new Error('synthetic timeout')
    }
  } as never)
  return {
    evaluate: async (fn: (arg: unknown) => unknown) => {
      const code = String(fn)
      if (code.includes('chat.send')) return { conversation: { id: 'conversation' }, assistantMessageId: 'original' }
      if (code.includes('chat.stop')) return undefined
      if (code.includes('chat.messages')) return [{ id: 'original', status: statuses.length > 1 ? statuses.shift() : statuses[0] }]
      throw new Error('unexpected app call')
    }
  } as unknown as Page
}
it('waits for the stopped original after abort rather than accepting a streaming snapshot', async () => {
  const result = await askInApp(timeoutPage(['streaming', 'stopped']), input)
  expect(result.message).toMatchObject({ id: 'original', status: 'stopped' })
})
it('blocks subsequent work with recoverable message identity if abort never reaches a terminal state', async () => {
  vi.useFakeTimers()
  const result = askInApp(timeoutPage(['streaming']), input).then(
    () => null,
    (e: unknown) => e
  )
  await vi.advanceTimersByTimeAsync(31_000)
  expect(await result).toMatchObject({ name: 'UnsettledAnswerError', conversationId: 'conversation', messageId: 'original' })
})

it('projects model selection onto the chat contract instead of passing numeric model context as a context packet', async () => {
  vi.spyOn(playwrightExpect, 'poll').mockImplementation(
    (check) =>
      ({
        toBe: async () => {
          expect(await check()).toBe(true)
        }
      }) as never
  )
  vi.stubGlobal('window', {
    jiwei: {
      chat: {
        send: (value: unknown) => {
          ChatSendSchema.parse(value)
          return { conversation: { id: 'conversation' }, assistantMessageId: 'original' }
        },
        messages: () => [{ id: 'original', status: 'done' }]
      }
    }
  })
  const page = { evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value) } as unknown as Page
  const result = await askInApp(page, { ...input, context: 1000000, contextSource: 'builtin', key: 'judge' } as typeof input)
  expect(result.message).toMatchObject({ id: 'original', status: 'done' })
})
