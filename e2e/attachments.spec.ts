import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { xlsxFixture, pptxFixture } from '../src/main/services/parsers/__tests__/fixtures'
import { navTo } from './fixtures/nav'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const userDataDir = mkdtempSync(join(tmpdir(), 'jiwei-chat-attachments-'))
test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_LANG: 'zh-CN',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_VOICE_MODELS_APPDATA: userDataDir,
      JIWEI_TEST_NETWORK: '1'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

test('P2 测试启动前已隔离模型缓存，不读取真实模型目录', async () => {
  expect(await app.evaluate(({ app }) => app.getPath('appData'))).toBe(process.env.JIWEI_TEST_MODEL_CACHE_ROOT)
  expect((await page.evaluate(() => window.jiwei.embedding.status())).state).not.toBe('ready')
})

test('P2 资料库导入 xlsx/csv/pptx/代码，真实作业解析并能打开阅读', async () => {
  const paths = [
    join(userDataDir, 'sales.xlsx'),
    join(userDataDir, 'sales.csv'),
    join(userDataDir, 'slides.pptx'),
    join(userDataDir, 'sample.ts')
  ]
  writeFileSync(paths[0], await xlsxFixture())
  writeFileSync(paths[1], 'name,value\nA,12\nB,18')
  writeFileSync(paths[2], await pptxFixture())
  writeFileSync(paths[3], '    const answer = 42')
  const result = await page.evaluate((files) => window.jiwei.sources.importPaths(files), paths)
  expect(result.imported).toHaveLength(4)
  for (const source of result.imported)
    await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), source.id)).length).toBeGreaterThan(0)
  const texts = await page.evaluate(
    async (ids) => Promise.all(ids.map(async (id) => (await window.jiwei.segments.list(id)).map((s) => s.text).join('\n'))),
    result.imported.map((s) => s.id)
  )
  expect(texts[0]).toContain('## 销售')
  expect(texts[1]).toContain('| A | 12 |')
  expect(texts[2]).toContain('讲者备注：备注 2')
  expect(texts[3]).toContain('```typescript\n    const answer = 42')
  await navTo(page, /资料库/)
  await expect(page.getByText('sales', { exact: true }).first()).toBeVisible()
})
