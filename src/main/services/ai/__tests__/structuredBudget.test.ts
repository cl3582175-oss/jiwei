import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV4 } from 'ai/test'
import { args, f, stream, success, usage } from './structuredFixture'
import { structured } from '../structured'
import log from 'electron-log/main'

function answering() {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: stream(success) }) })
}

it('纯文本请求复用同一自适应额度策略，length后翻倍而不包JSON', async () => {
  const { createModelRequest } = await import('../request')
  let count = 0
  f.model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: stream([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: ++count === 1 ? '' : '# Markdown' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: count === 1 ? 'length' : 'stop', raw: 'stop' }, usage: usage(100, 90) }
      ])
    })
  })
  await expect(createModelRequest(args()).generate('text')).resolves.toMatchObject({ text: '# Markdown' })
  expect(f.model.doStreamCalls.map((c) => c.maxOutputTokens)).toEqual([8192, 16384])
  expect(f.model.doStreamCalls.every((c) => !c.tools?.length)).toBe(true)
})

it('SDK强制工具校验不能吞掉服务商的length和推理用量', async () => {
  const { generateWithIdle } = await import('../request')
  f.model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: stream([
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: 'thinking' },
        { type: 'reasoning-end', id: 'r' },
        { type: 'finish', finishReason: { unified: 'length', raw: 'length' }, usage: usage(4096, 4095) }
      ])
    })
  })
  await expect(
    generateWithIdle({
      model: f.model,
      prompt: 'Controlled',
      tools: { submit: { inputSchema: z.object({ ok: z.boolean() }) } },
      toolChoice: { type: 'tool', toolName: 'submit' }
    })
  ).resolves.toMatchObject({ finishReason: 'length', usage: { outputTokens: 4096, outputTokenDetails: { reasoningTokens: 4095 } } })
})

it('明确公开的诊断保留正文前120字，未知来源不输出正文', async () => {
  const { generateWithIdle } = await import('../request')
  vi.mocked(log.warn).mockClear()
  const body = 'PUBLIC-MARKER-' + 'a'.repeat(200)
  f.model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: stream([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: body },
        { type: 'text-end', id: 't' },
        { type: 'error', error: new Error('Controlled transport failure') }
      ])
    })
  })
  await expect(generateWithIdle({ model: f.model, prompt: 'Controlled', diagnostics: { sensitive: false } })).rejects.toThrow()
  const lines = vi.mocked(log.warn).mock.calls.map((c) => String(c[0]))
  expect(lines.some((l) => l.includes(body.slice(0, 120)))).toBe(true)
  expect(lines.some((l) => l.includes(body.slice(0, 121)))).toBe(false)
})

it('显式小额度不覆盖模型默认值，显式大额度与学习上限分别生效', async () => {
  f.model = answering()
  await structured({ ...args(), maxOutputTokens: 1024, schema: z.object({ ok: z.boolean() }) })
  expect(f.model.doStreamCalls[0].maxOutputTokens).toBe(8192)
  f.model = answering()
  await structured({ ...args(), maxOutputTokens: 32768, schema: z.object({ ok: z.boolean() }) })
  expect(f.model.doStreamCalls[0].maxOutputTokens).toBe(32768)
  f.learned = 6000
  f.model = answering()
  await structured({ ...args(), maxOutputTokens: 32768, schema: z.object({ ok: z.boolean() }) })
  expect(f.model.doStreamCalls[0].maxOutputTokens).toBe(6000)
})

it('第二次仍截断时抛类型化错误，报告推理比例且不继续付费回退', async () => {
  f.model = new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({ stream: stream([{ type: 'finish', finishReason: { unified: 'length', raw: 'length' }, usage: usage(100, 90) }]) })
  })
  await expect(structured({ ...args(), schema: z.object({ ok: z.boolean() }) })).rejects.toMatchObject({
    name: 'ModelOutputTruncated',
    message: expect.stringContaining('90%')
  })
  expect(f.model.doStreamCalls).toHaveLength(2)
})

it.each([
  ['max_tokens must be at most 6000; requested 8192', 6000],
  ['max_output_tokens must be between 1 and 5000', 5000],
  ['maximum output token limit is 7000', 7000],
  ['max_tokens is invalid', 4096]
])('400额度拒绝自适应并记住被服务商接受的值：%s', async (message, limit) => {
  let first = true
  f.model = new MockLanguageModelV4({
    doStream: async () => {
      if (first) {
        first = false
        throw Object.assign(new Error(message), { statusCode: 400 })
      }
      return { stream: stream(success) }
    }
  })
  await expect(structured({ ...args(), schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true })
  expect(f.model.doStreamCalls.map((c) => c.maxOutputTokens)).toEqual([8192, limit])
  expect(f.learned).toBe(limit)
  f.model = answering()
  await structured({ ...args(), schema: z.object({ ok: z.boolean() }) })
  expect(f.model.doStreamCalls[0].maxOutputTokens).toBe(limit)
})

it('上下文超限不是输出额度上限，不错误地学习缩小模型', async () => {
  f.model = new MockLanguageModelV4({
    doStream: async () => {
      throw Object.assign(new Error('maximum context length is 32000; input tokens exceed context'), { statusCode: 400 })
    }
  })
  await expect(structured({ ...args(), schema: z.object({ ok: z.boolean() }) })).rejects.toThrow('context')
  expect(f.learned).toBeUndefined()
  expect(f.model.doStreamCalls.every((c) => c.maxOutputTokens === 8192)).toBe(true)
})

it('JSON回退剥离think段，保留length重试后额度', async () => {
  let n = 0
  f.model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: stream(
        ++n === 1
          ? [{ type: 'finish', finishReason: { unified: 'length', raw: 'length' }, usage: usage(100, 99) }]
          : [
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: '<think>{"invalid":true}</think>\n{"ok":true}' },
              { type: 'text-end', id: 't' },
              success[1]
            ]
      )
    })
  })
  await expect(structured({ ...args(), schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true })
  expect(f.model.doStreamCalls.map((c) => c.maxOutputTokens)).toEqual([8192, 16384, 16384])
})

it('附件内容失败诊断只记长度，不把正文写入日志', async () => {
  vi.mocked(log.warn).mockClear()
  f.model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: stream([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'PRIVATE-OUTPUT-MARKER' },
        { type: 'text-end', id: 't' },
        success[1]
      ])
    })
  })
  await expect(structured({ ...args(), sensitive: true, schema: z.object({ ok: z.boolean() }) })).rejects.toThrow()
  const warnings = JSON.stringify(vi.mocked(log.warn).mock.calls)
  expect(warnings).not.toContain('PRIVATE-OUTPUT-MARKER')
  expect(warnings).toContain('textLength')
})

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

it('只把明确指向输出额度的400当作额度反馈', async () => {
  const { rejectedOutputLimit } = await import('../request')
  const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 })
  expect(rejectedOutputLimit(bad('maximum number of tools is 128'), 8192)).toBeNull()
  expect(rejectedOutputLimit(bad('messages exceed the maximum allowed'), 8192)).toBeNull()
  expect(rejectedOutputLimit(bad('max_tokens must be less than or equal to 4096'), 8192)).toBe(4096)
  expect(rejectedOutputLimit(bad('maximum output tokens is 6000'), 8192)).toBe(6000)
})
