import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { attachmentModel, textOf } from './fixtures/attachment-model'
import { askInApp } from './fixtures/ragChat'
import { navTo } from './fixtures/nav'

let app: ElectronApplication,
  page: Page,
  providerId = '',
  sourceId = ''
let model: Awaited<ReturnType<typeof attachmentModel>>
const directory = mkdtempSync(join(tmpdir(), 'jiwei-rag-retrieval-'))
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  model = await attachmentModel()
  const old = process.env.JIWEI_TEST_MODEL_CACHE_ROOT
  process.env.JIWEI_TEST_MODEL_CACHE_ROOT = join(directory, 'empty-cache')
  try {
    app = await launchRagApp(directory)
  } finally {
    if (old === undefined) delete process.env.JIWEI_TEST_MODEL_CACHE_ROOT
    else process.env.JIWEI_TEST_MODEL_CACHE_ROOT = old
  }
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  providerId = await page.evaluate(async (baseUrl) => {
    const provider = await window.jiwei.providers.save({
      kind: 'openai',
      name: 'Controlled retrieval',
      baseUrl,
      apiKey: 'controlled-test-key',
      models: ['rag-controlled'],
      modelCaps: { 'rag-controlled': { vision: false, tools: true, tier: 'strong' } }
    })
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...settings.ai, chat: { providerId: provider.id, model: 'rag-controlled' }, effort: 'off' },
      retrieval: { autoUpgrade: false, mode: 'off' }
    })
    return provider.id
  }, model.url)
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => model?.server.close(() => resolve()))
})
const ask = (text: string, scope: Parameters<typeof askInApp>[1]['scope'], conversationId?: string) =>
  askInApp(page, { providerId, model: 'rag-controlled', text, scope, conversationId })
const lastUser = () =>
  model.requests
    .filter((r) => r.stream)
    .at(-1)!
    .messages.filter((m) => m.role === 'user')
    .map((m) => textOf(m.content))
    .at(-1)!

test('explicit small source sends all15 sections with clickable persisted citations', async () => {
  const path = join(directory, 'Synthetic-source.md')
  writeFileSync(
    path,
    Array.from(
      { length: 15 },
      (_, i) => `# Section ${i + 1}\n\nEvidence segment ${i + 1}. ${'Complete synthetic reading context. '.repeat(6)}END-${i + 1}`
    ).join('\n\n')
  )
  sourceId = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)).length).toBe(15)
  model.setAnswer('The final source passage supplies this evidence [15].')
  const response = await ask('请完整阅读指定资料并引用最后一节。', { type: 'items', notes: [], sources: [sourceId] })
  expect(response.message.status).toBe('done')
  expect(lastUser()).toContain('END-15')
  expect(lastUser()).toContain('[15] 资料《Synthetic-source》 › Section 15')
  expect(
    model.requests
      .filter((r) => r.stream)
      .at(-1)!
      .messages.some(
        (m) => m.role === 'system' && textOf(m.content).includes('以下是用户指定资料的全文，请完整阅读后回答，并引用具体片段。')
      )
  ).toBe(true)
  const segments = await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)
  expect(response.message.citations[0]).toMatchObject({ n: 15, ownerId: segments[14].id })
  await navTo(page, /AI 对话/)
  await page.getByText('请完整阅读指定资料并引用最后一节。', { exact: true }).first().click()
  await page.locator('.cite-chip').first().click()
  await expect(page.locator('.source-text .is-flash')).toContainText('END-15')
})

test('follow-up composition is shared with evaluation and used by actual chat retrieval', async () => {
  const first = await ask('合成温控装置的维护周期要求是什么，请从已有资料中找出？', { type: 'all' })
  const path = join(directory, 'Synthetic-maintenance.md')
  writeFileSync(path, '# 合成温控装置\n\n合成温控装置的维护周期要求为每隔七天复查。FOLLOWUP-EVIDENCE')
  const id = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), id)).length).toBeGreaterThan(0)
  expect(
    await page.evaluate(() => window.jiwei.knowledge.queryFor('还有呢？', '合成温控装置的维护周期要求是什么，请从已有资料中找出？'))
  ).toContain('\n合成温控装置')
  await ask('还有呢？', { type: 'all' }, first.conversationId)
  expect(lastUser()).toContain('FOLLOWUP-EVIDENCE')
})

test('knowledge_search sourceIds are enforced on the real tool path', async () => {
  const path = join(directory, 'Outside-scope.md')
  writeFileSync(path, '# Outside\n\nOUTSIDE-SCOPE-CONTENT')
  const outside = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), outside)).length).toBeGreaterThan(0)
  model.tool('knowledge_search', { query: 'OUTSIDE', sourceIds: [outside] })
  const response = await ask('请再检索所选资料。', { type: 'items', notes: [], sources: [sourceId] })
  expect(
    response.message.steps.some((step) => step.status === 'error' && JSON.stringify(step).includes('outside the selected scope'))
  ).toBe(true)
  expect(lastUser()).not.toContain('OUTSIDE-SCOPE-CONTENT')
})
