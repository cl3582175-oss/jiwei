import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'fs'

// P0：最小真实页面验证 Streamdown 的增量属性和多围栏身份。
let server: ViteDevServer, browser: Browser, page: Page
test.beforeAll(async () => {
  server = await createServer({ configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome' })
  page = await browser.newPage()
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/ui-tech.html`)
  await page.waitForFunction(() => !!window.uiProbe)
})
test.afterAll(async () => {
  await browser?.close()
  await server?.close()
})

test('流式属性逐步增长，多个代码块保持组件实例', async () => {
  const info = test.info()
  const first = '```jiwei-ui\n{"type":"list","items":[{"text":"第一条"}]}'
  const frames = [
    first.slice(0, 31),
    first,
    `${first}\n\`\`\`\n\n正文\n\n\`\`\`jiwei-ui\n{"type":"table"`,
    `${first}\n\`\`\`\n\n正文\n\n\`\`\`jiwei-ui\n{"type":"table","rows":[]}\n\`\`\``
  ]
  const identities: string[][] = []
  for (const text of frames) {
    await page.evaluate((s) => window.uiProbe.setText(s), text)
    await expect(page.locator('pre[data-instance]')).toHaveCount(text.includes('正文') ? 2 : 1)
    await expect(page.locator('pre[data-instance]').last()).toContainText(text.includes('正文') ? 'table' : 'list')
    identities.push(await page.locator('pre[data-instance]').evaluateAll((els) => els.map((el) => el.getAttribute('data-instance')!)))
  }
  expect(identities.map((ids) => ids[0])).toEqual(['1', '1', '1', '1'])
  expect(identities[2][1]).toBe(identities[3][1])
  await expect(page.locator('pre[data-instance]').last()).toHaveAttribute('data-incomplete', 'false')
  const probe = await page.evaluate(() => ({
    observations: window.uiProbe.observations,
    mounts: window.uiProbe.mounts,
    unmounts: window.uiProbe.unmounts
  }))
  await info.attach('streamdown-observations', { body: JSON.stringify({ ...probe, identities }, null, 2), contentType: 'application/json' })
  expect(probe.observations.some((o) => o.incomplete && o.code.includes('list'))).toBe(true)
  expect(probe.observations.filter((o) => o.instance === 1).map((o) => o.code.trim())).toContain(
    '{"type":"list","items":[{"text":"第一条"}]}'
  )
  writeFileSync(info.outputPath('observations.json'), JSON.stringify(probe, null, 2))
  expect(probe.mounts).toEqual([1, 2])
  expect(probe.unmounts).toEqual([])
  await page.screenshot({ path: info.outputPath('multiple-fences.png') })
})
