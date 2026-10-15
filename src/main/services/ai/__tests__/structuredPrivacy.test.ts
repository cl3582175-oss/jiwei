import { expect, it } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV4 } from 'ai/test'
import { args, f, stream, usage } from './structuredFixture'
import { structured } from '../structured'

// 原 lib/__tests__/structured.test.ts 针对 generateText；请求层改为流式后迁到这里，断言不变。
const answer = (value: string) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: stream([
        { type: 'tool-call', toolCallId: 'call', toolName: 'submit', input: JSON.stringify({ answer: value }) },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage() }
      ])
    })
  })
const schema = z.object({ answer: z.string() })

it('rechecks privacy after a successful model call before returning', async () => {
  let allowed = true
  const model = answer('late')
  const original = model.doStream.bind(model)
  model.doStream = async (o) => {
    allowed = false
    return original(o)
  }
  f.model = model
  const guard = () => {
    if (!allowed) throw new Error('private now')
  }
  await expect(structured({ ...args(), schema, guard })).rejects.toThrow('private now')
  expect(model.doStreamCalls).toHaveLength(1)
})

it('sends image bytes with the same text task', async () => {
  f.model = answer('ok')
  await expect(
    structured({ ...args(), schema, effort: 'high', images: [{ data: new Uint8Array([1, 2]), mediaType: 'image/png' }] })
  ).resolves.toEqual({ answer: 'ok' })
  const user = f.model.doStreamCalls[0].prompt.find((m) => m.role === 'user')!
  expect(user.content).toEqual([
    expect.objectContaining({ type: 'file', mediaType: 'image/png' }),
    expect.objectContaining({ type: 'text', text: args().prompt })
  ])
})
