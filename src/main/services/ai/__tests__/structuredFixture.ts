import { beforeEach, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'

const f = vi.hoisted(() => ({ model: null as MockLanguageModelV4 | null, learned: undefined as number | undefined }))
export { f }
vi.mock('../model', () => ({ buildModel: () => ({ model: f.model!, maxOutputTokens: 8192 }) }))
vi.mock('../providers', () => ({
  getProviderRow: () => ({ modelCaps: JSON.stringify(f.learned ? { controlled: { learnedMaxOutput: f.learned } } : {}) }),
  learnOutputLimit: (_id: string, _model: string, limit: number) => {
    f.learned = limit
  }
}))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('../../settings', () => ({ getSettings: () => ({ language: 'zh-CN' }) }))

export const usage = (total = 10, reasoning = 0) => ({
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total, text: total - reasoning, reasoning }
})
export function stream(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const part of parts) c.enqueue(part)
      c.close()
    }
  })
}
export const success: LanguageModelV4StreamPart[] = [
  { type: 'tool-call', toolCallId: 'call', toolName: 'submit', input: '{"ok":true}' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage() }
]
export const args = () => ({ providerId: 'controlled', model: 'controlled', system: 'Return a result', prompt: 'Controlled input' })
beforeEach(() => {
  f.learned = undefined
})
