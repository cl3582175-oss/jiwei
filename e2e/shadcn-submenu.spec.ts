import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'

const source = `
import React, { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent
} from '/src/renderer/src/components/ui/dropdown-menu'
import '/src/renderer/src/styles/globals.css'

function App() {
  const [selected, setSelected] = useState('none')
  const record = (event) => {
    window.menuEvents ??= []
    window.menuEvents.push({ ...event, at: performance.now() })
  }
  return <main style={{ padding: 24, height: '100vh', overflow: 'hidden' }}>
    <DropdownMenu onOpenChange={(open) => record({ open })}>
      <DropdownMenuTrigger>打开长菜单</DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-24 w-44" aria-label="父菜单"
        onPointerDownOutside={(event) => record({ outside: event.detail.originalEvent.target?.getAttribute('data-slot') })}>
        <DropdownMenuItem onSelect={() => setSelected('parent')}>父层动作</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>长子菜单</DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="长子菜单选项">
            {Array.from({ length: 80 }, (_, index) => <DropdownMenuItem key={index} onSelect={() => setSelected('child-' + (index + 1))}>
              {'子项 ' + String(index + 1).padStart(2, '0')}
            </DropdownMenuItem>)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem>父层结束动作</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <output data-testid="selection">{selected}</output>
  </main>
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
`

let server: ViteDevServer
let browser: Browser
let page: Page
let errors: string[]

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    // This virtual component probe must not scan production build HTML entries.
    optimizeDeps: {
      entries: [],
      include: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        'lucide-react',
        'radix-ui',
        'clsx',
        'tailwind-merge'
      ]
    },
    cacheDir: join(tmpdir(), 'jiwei-shadcn-submenu-vite'),
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'long-submenu-regression',
        resolveId: (id) => (id === '/@submenu-regression' ? '\0submenu-regression' : undefined),
        load: (id) => (id === '\0submenu-regression' ? source : undefined),
        transform(code, id) {
          if (id === '\0submenu-regression')
            return transformWithEsbuild(code, 'submenu-regression.tsx', { loader: 'tsx', jsx: 'automatic' })
        },
        configureServer(vite) {
          vite.middlewares.use('/__submenu_regression__', async (_request, response) => {
            const html = await vite.transformIndexHtml(
              '/__submenu_regression__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/@submenu-regression"></script></body></html>'
            )
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          })
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }
  })
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome' })
})

test.afterAll(async () => {
  await browser?.close()
  await server?.close()
})

test.beforeEach(async () => {
  errors = []
  page = await browser.newPage({ viewport: { width: 1000, height: 640 } })
  page.on('pageerror', (error) => errors.push(error.message))
  // cn shares a module with desktop platform formatting; no business API is replaced.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'platform', { value: { os: 'darwin' } })
  })
  await page.goto(`${server.resolvedUrls!.local[0]}__submenu_regression__`)
  await expect(page.getByRole('button', { name: '打开长菜单', exact: true })).toBeVisible()
})

test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus) {
    await test.info().attach('submenu-failure', { body: await page.screenshot(), contentType: 'image/png' })
    await test.info().attach('submenu-failure-state', { body: await page.locator('body').ariaSnapshot(), contentType: 'text/plain' })
  }
  await page?.close()
  expect(errors, 'production dropdown source runtime errors').toEqual([])
})

test('long child menu escapes parent clipping, scrolls at 1000x640 and actually selects its last item', async () => {
  const trigger = page.getByRole('button', { name: '打开长菜单', exact: true })
  await trigger.click()
  await page.getByRole('menuitem', { name: '长子菜单', exact: true }).hover()
  const child = page.getByRole('menu', { name: '长子菜单', exact: true })
  await expect(child).toBeVisible()
  await child.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
  })
  const metrics = await child.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: style.overflowY,
      nestedInParentClip: !!element.parentElement?.closest('[data-slot="dropdown-menu-content"]')
    }
  })
  const metricsPath = test.info().outputPath('submenu-initial-metrics.json')
  writeFileSync(metricsPath, JSON.stringify(metrics, null, 2))
  await test.info().attach('submenu-initial-metrics', { path: metricsPath, contentType: 'application/json' })
  expect.soft(metrics.bottom, 'the child must fit the actual viewport').toBeLessThanOrEqual(640)
  expect.soft(metrics.top).toBeGreaterThanOrEqual(0)
  expect.soft(metrics.scrollHeight, '80 items require a bounded scroll container').toBeGreaterThan(metrics.clientHeight)
  expect.soft(metrics.overflowY).toBe('auto')
  expect.soft(metrics.nestedInParentClip, 'the child portal must escape the 96px parent menu clip').toBe(false)
  const bounds = await child.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width / 2, Math.max(1, Math.min(638, bounds!.y + 80)))
  await page.mouse.wheel(0, 5000)
  await expect.poll(() => child.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const last = child.getByRole('menuitem', { name: '子项 80', exact: true })
  await expect(last).toBeInViewport()
  const screenshot = test.info().outputPath('submenu-last-item-visible.png')
  await page.screenshot({ path: screenshot })
  await test.info().attach('submenu-last-item-visible', { path: screenshot, contentType: 'image/png' })
  await last.click()
  await expect(page.getByTestId('selection')).toHaveText('child-80')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
})

test('Escape closes only the scrollable child, restores its trigger, and a second Escape restores the root entry', async () => {
  const trigger = page.getByRole('button', { name: '打开长菜单', exact: true })
  await trigger.click()
  const subTrigger = page.getByRole('menuitem', { name: '长子菜单', exact: true })
  await subTrigger.focus()
  await page.keyboard.press('ArrowRight')
  const child = page.getByRole('menu', { name: '长子菜单', exact: true })
  await expect(child.getByRole('menuitem', { name: '子项 01', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(child.getByRole('menuitem', { name: '子项 80', exact: true })).toBeFocused()
  await expect(child.getByRole('menuitem', { name: '子项 80', exact: true })).toBeInViewport()
  await page.keyboard.press('Escape')
  await expect(child).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(1)
  await expect(subTrigger).toBeFocused()
  await expect(page.getByTestId('selection')).toHaveText('none')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
})

test('a real pointer can reopen the root immediately after Escape and select an action', async () => {
  // Modal menus correctly hide the trigger from the accessibility tree while open.
  const trigger = page.locator('[data-slot="dropdown-menu-trigger"]')
  const bounds = await trigger.boundingBox()
  expect(bounds).not.toBeNull()
  await trigger.click()
  const menu = page.getByRole('menu', { name: '打开长菜单', exact: true })
  await menu.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
  })
  await page.keyboard.press('Escape')
  // Raw pointer input deliberately reaches the closing interval; locator click would
  // wait for old layers to disappear and conceal a rapid user interaction regression.
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  const observed = await page.evaluate(() => ({
    events: (window as typeof window & { menuEvents?: unknown[] }).menuEvents,
    content: [...document.querySelectorAll('[data-slot="dropdown-menu-content"]')].map((element) => ({
      state: element.getAttribute('data-state'),
      animation: getComputedStyle(element).animationName
    }))
  }))
  const eventsPath = test.info().outputPath('rapid-reopen-events.json')
  writeFileSync(eventsPath, JSON.stringify(observed, null, 2))
  await test.info().attach('rapid-reopen-events', { path: eventsPath, contentType: 'application/json' })
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await menu.getByRole('menuitem', { name: '父层动作', exact: true }).click()
  await expect(page.getByTestId('selection')).toHaveText('parent')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
