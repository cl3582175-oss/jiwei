import { expect, it } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV4 } from 'ai/test'
import { args, f, stream, success, usage } from './structuredFixture'
import { structured } from '../structured'

it('推理耗尽输出额度时翻倍重试，off档不再使用4096', async () => {
  f.model = new MockLanguageModelV4({
    doGenerate: [
      { content: [], finishReason: { unified: 'length', raw: 'length' }, usage: usage(4096, 4095), warnings: [] },
      {
        content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'submit', input: '{"ok":true}' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usage(),
        warnings: []
      }
    ],
    doStream: [
      { stream: stream([{ type: 'finish', finishReason: { unified: 'length', raw: 'length' }, usage: usage(4096, 4095) }]) },
      { stream: stream(success) }
    ]
  })
  await expect(structured({ ...args(), schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true })
  const calls = [...f.model.doGenerateCalls, ...f.model.doStreamCalls]
  expect(calls[0].maxOutputTokens).toBe(8192)
  expect(calls[1].maxOutputTokens).toBe(16384)
})
