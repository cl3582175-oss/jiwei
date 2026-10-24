import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

let server: ViteDevServer
let browser: Browser
let page: Page
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', port: 0 }
  })
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome' })
})
test.beforeEach(async () => {
  page = await browser.newPage()
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/settings-components.html`)
})
test.afterEach(async () => {
  await page.close()
})
test.afterAll(async () => {
  await browser?.close()
  await server?.close()
})

test('production settings radio exposes its full visible click target and changes the controlled policy', async () => {
  const group = page.getByRole('radiogroup', { name: '工具策略', exact: true })
  const automatic = group.getByRole('radio', { name: '自动', exact: true })
  await expect(automatic).toBeVisible()
  const box = (await automatic.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(40)
  expect(box.height).toBeGreaterThanOrEqual(24)
  expect(
    await automatic.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return hit === element || element.contains(hit)
    })
  ).toBe(true)
  await automatic.click()
  await expect(automatic).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('policy')).toHaveText('auto')
  expect(await automatic.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px')
  await automatic.focus()
  await page.keyboard.down('ArrowRight')
  try {
    await expect(group.getByRole('radio', { name: '禁止', exact: true })).toBeFocused()
    await expect(page.getByTestId('policy')).toHaveText('deny')
  } finally {
    await page.keyboard.up('ArrowRight')
  }
})

test('production settings radio keeps disabled policies disabled and skips them with the keyboard', async () => {
  const group = page.getByRole('radiogroup', { name: '对外工具策略', exact: true })
  const automatic = group.getByRole('radio', { name: '自动', exact: true })
  await expect(automatic).toBeDisabled()
  await automatic.evaluate((element) => (element as HTMLButtonElement).click())
  await expect(page.getByTestId('external-policy')).toHaveText('ask')
  await group.getByRole('radio', { name: '每次询问', exact: true }).focus()
  await page.keyboard.down('ArrowRight')
  try {
    await expect(group.getByRole('radio', { name: '禁止', exact: true })).toBeFocused()
    await expect(page.getByTestId('external-policy')).toHaveText('deny')
  } finally {
    await page.keyboard.up('ArrowRight')
  }
})
