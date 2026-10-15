import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { attachmentModel, textOf } from './fixtures/attachment-model'
import { sendJudgement } from './fixtures/ragJudgeTransport'
import { parseJudgement } from './fixtures/ragJudge'
import { captureRagRequests, takeRagRequests } from './fixtures/ragRequests'

test('a large judgement reaches the app in bounded messages with complete retained history', async () => {
  const model = await attachmentModel(),
    app = await launchRagApp(mkdtempSync(join(tmpdir(), 'rag-judge-transport-')))
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    const p = await page.evaluate(
      (baseUrl) => window.jiwei.providers.save({ kind: 'custom', baseUrl, apiKey: 'controlled-test-key', models: ['judge-controlled'] }),
      model.url
    )
    model.setAnswer('{"correct":2,"complete":2,"citations":2,"honesty":2,"refused":false,"reason":"Synthetic pass"}')
    const prompt =
      '评分规则：只返回合法JSON数字。\n<evaluation-data>' +
      JSON.stringify({ text: 'LONG-JUDGE-START-' + 'Complete synthetic scoring evidence. '.repeat(3600) + '-LONG-JUDGE-TAIL' }) +
      '</evaluation-data>'
    const target = { providerId: p.id, model: 'judge-controlled', key: 'fixed-judge', context: 1000000, contextSource: 'builtin' }
    await captureRagRequests(app)
    const answer = await sendJudgement(page, target, prompt)
    expect(answer.transport.preparations).toHaveLength(8)
    expect(parseJudgement(answer.message.content)?.total).toBe(8)
    const requests = model.requests.filter((r) => r.stream)
    expect(requests).toHaveLength(answer.transport.preparations.length + 1)
    expect(requests.every((r) => textOf(r.messages.filter((m) => m.role === 'user').at(-1)!.content).length <= 20000)).toBe(true)
    const final = requests
      .at(-1)!
      .messages.filter((m) => m.role === 'user')
      .map((m) => textOf(m.content))
      .join('\n')
    expect(final).toContain('LONG-JUDGE-START')
    expect(final).toContain('LONG-JUDGE-TAIL')
    const restored = requests
      .at(-1)!
      .messages.filter((m) => m.role === 'user')
      .slice(0, -1)
      .map((m) => {
        const text = textOf(m.content)
        return text.slice(text.indexOf('\n<evaluation-part>\n') + 19, text.lastIndexOf('\n</evaluation-part>'))
      })
      .join('')
    expect(restored).toBe(prompt)
    const captured = await takeRagRequests(app)
    expect(captured).toHaveLength(9)
    expect(captured.every((r) => r.status === 200)).toBe(true)
  } finally {
    await app.close()
    await new Promise<void>((r) => model.server.close(() => r()))
  }
})
