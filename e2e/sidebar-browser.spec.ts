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
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/sidebar-components.html`)
})
test.afterEach(async () => {
  await page.close()
})
test.afterAll(async () => {
  await browser?.close()
  await server?.close()
})

test('production sidebar has a direct full-size expand-and-pin control without covering the content', async () => {
  const sidebar = page.getByTestId('sidebar-notes')
  const expand = sidebar.getByTestId('sidebar-expand-pin')
  await expect(expand).toBeVisible()
  const box = (await expand.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(28)
  expect(box.height).toBeGreaterThanOrEqual(28)
  expect(box.x + box.width).toBeLessThanOrEqual((await page.getByTestId('main-content').boundingBox())!.x)
  await expand.hover()
  await page.waitForTimeout(600) // Waiting beyond the preview delay proves the button stays directly clickable.
  await expect(sidebar).toHaveAttribute('data-peeking', 'false')
  await expand.click()
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
  await page.mouse.move(1200, 600)
  await page.waitForTimeout(600)
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
  await sidebar.getByTestId('sidebar-toggle').click()
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
})

test('production hover preview stays open across the heading, top padding, and pin control', async () => {
  const sidebar = page.getByTestId('sidebar-notes')
  await sidebar.getByTestId('sidebar-spine').hover()
  await expect(sidebar).toHaveAttribute('data-peeking', 'true')
  const panel = (await sidebar.getByTestId('sidebar-panel').boundingBox())!
  await page.mouse.move(panel.x + 120, 4)
  await page.waitForTimeout(600) // Cross the former 8px gap and remain beyond the leave timer.
  await expect(sidebar).toHaveAttribute('data-peeking', 'true')
  await sidebar.getByTestId('sidebar-heading').hover()
  await page.waitForTimeout(600)
  await expect(sidebar).toHaveAttribute('data-peeking', 'true')
  await sidebar.getByTestId('sidebar-toggle').hover()
  await page.waitForTimeout(600)
  await expect(sidebar).toHaveAttribute('data-peeking', 'true')
  await sidebar.getByRole('button', { name: '实际列表操作', exact: true }).click()
  await page.mouse.move(1200, 600)
  await expect(sidebar).toHaveAttribute('data-peeking', 'false')
  await sidebar.getByTestId('sidebar-spine').hover()
  await expect(sidebar).toHaveAttribute('data-peeking', 'true')
  await sidebar.getByTestId('sidebar-toggle').click()
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
  await expect(sidebar).toHaveAttribute('data-peeking', 'false')
  await sidebar.getByTestId('sidebar-toggle').click()
  await sidebar.getByTestId('sidebar-spine').hover()
  await expect(sidebar).toHaveAttribute('data-peeking', 'true')
  await page.mouse.move(1200, 600)
  await expect(sidebar).toHaveAttribute('data-peeking', 'false')
})

test('production page controls preserve separate widths through narrow-window pin and release', async () => {
  for (const current of [
    { id: 'notes' as const, name: '笔记', start: 300, width: 330 },
    { id: 'chat' as const, name: '助手', start: 340, width: 370 }
  ]) {
    await page.getByRole('navigation').getByRole('button', { name: current.name, exact: true }).click()
    const sidebar = page.getByTestId(`sidebar-${current.id}`)
    await sidebar.getByTestId('sidebar-expand-pin').click()
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(current.start)
    const handle = (await sidebar.getByTestId('sidebar-resize').boundingBox())!
    const x = handle.x + handle.width / 2
    await page.mouse.move(x, handle.y + 250)
    await page.mouse.down()
    await page.mouse.move(x + 30, handle.y + 250, { steps: 4 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(current.width)
    await page.setViewportSize({ width: 1000, height: 700 })
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
    await sidebar.getByTestId('sidebar-expand-pin').click()
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    await sidebar.getByTestId('sidebar-toggle').click()
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(current.width)
    await sidebar.getByTestId('sidebar-toggle').click()
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
  }
  await expect
    .poll(() => page.evaluate(() => window.jiwei.settings.get().then((saved) => saved.sidebars)))
    .toEqual({
      notes: { collapsed: true, width: 330 },
      chat: { collapsed: true, width: 370 }
    })
})

test('hover preview suspends background native drag regions and restores them on close or pin', async () => {
  const background = page.getByTestId('main-content').locator('.drag')
  for (const name of ['笔记', '助手']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
    const sidebar = page.getByTestId(name === '笔记' ? 'sidebar-notes' : 'sidebar-chat')
    const region = () => background.evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'))
    await expect.poll(region).toBe('drag')
    await sidebar.getByTestId('sidebar-spine').hover()
    await expect(sidebar).toHaveAttribute('data-peeking', 'true')
    // Electron's native hit test still uses the covered background's drag regions.
    // A no-drag preview header alone cannot protect the overlaid part of this header.
    await expect.poll(region).toBe('no-drag')
    await page.mouse.move(1200, 600)
    await expect(sidebar).toHaveAttribute('data-peeking', 'false')
    await expect.poll(region).toBe('drag')
    await sidebar.getByTestId('sidebar-spine').hover()
    await expect(sidebar).toHaveAttribute('data-peeking', 'true')
    await expect.poll(region).toBe('no-drag')
    await sidebar.getByTestId('sidebar-toggle').click()
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    await expect.poll(region).toBe('drag')
    await expect.poll(() => sidebar.getByTestId('sidebar-heading').evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('drag')
  }
})
