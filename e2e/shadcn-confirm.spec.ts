import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isolatedElectron } from './fixtures/isolateElectron'

// This fixture renders the production Promise API and Radix/shadcn host directly,
// under StrictMode. Product persistence is checked separately in real Electron.
const probeSource = `
import React, { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '/src/renderer/src/i18n'
import { DialogHost, confirm, prompt, useConfirmSignal } from '/src/renderer/src/components/ui/shadcn-confirm'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from '/src/renderer/src/components/ui/dialog'
import '/src/renderer/src/styles/globals.css'

const results = []
const probe = window.confirmProbe = { results, confirm, prompt, writes: [], attempts: 0, language: (lang) => i18n.changeLanguage(lang) }
const record = (name, promise) => { promise.then(value => results.push([name, value])); return promise }
function Owner({ scope }) {
  const signal = useConfirmSignal(scope)
  probe.ownerSignal = signal
  return <button onClick={() => record('owner', confirm({ title: 'owned ' + scope, signal }))}>owner confirm</button>
}
function App() {
  const [host, setHost] = useState(true)
  const [owner, setOwner] = useState('one')
  const [showTrigger, setShowTrigger] = useState(true)
  probe.setHost = setHost
  probe.setOwner = setOwner
  probe.removeTrigger = () => setShowTrigger(false)
  probe.queue = () => {
    record('first', confirm({ title: 'first', description: 'first description', danger: true }))
    record('second', prompt({ title: 'second', description: 'second description', defaultValue: 'original', placeholder: 'name' }))
  }
  return <I18nextProvider i18n={i18n}><main data-workspace="confirm-probe" className="p-6">
    <button onClick={() => {}}>safe action</button>
    {showTrigger && <button onClick={probe.queue}>queue pair</button>}
    <button onClick={() => record('prompt', prompt({ title: 'rename', defaultValue: 'original', placeholder: 'name' }))}>rename</button>
    <button onClick={() => record('write', prompt({ title: 'recoverable rename', defaultValue: 'original', submit: async value => {
      probe.attempts += 1
      if (probe.attempts === 1) throw new Error('controlled write failure')
      await new Promise(resolve => { probe.finishWrite = resolve })
      probe.writes.push(value)
    } }))}>recoverable rename</button>
    {owner !== null && <Owner scope={owner} />}
    <Dialog><DialogTrigger asChild><button>open outer</button></DialogTrigger>
      <DialogContent><DialogTitle>outer</DialogTitle><DialogDescription>outer description</DialogDescription>
        <button onClick={() => record('nested', confirm({ title: 'nested', description: 'nested description' }))}>nested confirm</button>
      </DialogContent>
    </Dialog>
    {host && <DialogHost />}
  </main></I18nextProvider>
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
`

declare global {
  interface Window {
    confirmProbe: {
      results: [string, boolean | string | null][]
      confirm(options: { title: string; operationKey?: string; signal?: AbortSignal }): Promise<boolean>
      prompt(options: { title: string; operationKey?: string; signal?: AbortSignal }): Promise<string | null>
      language(language: string): Promise<unknown>
      setHost(visible: boolean): void
      setOwner(scope: string | null): void
      removeTrigger(): void
      ownerSignal: AbortSignal
      attempts: number
      writes: string[]
      finishWrite(): void
    }
  }
}

let server: ViteDevServer
let browser: Browser
let page: Page

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    // The entry is virtual. Discover its imports on demand, without scanning
    // unrelated HTML files in the application's production build directories.
    optimizeDeps: {
      entries: [],
      include: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        'react-i18next',
        'i18next',
        'lucide-react',
        'radix-ui',
        'class-variance-authority',
        'clsx',
        'tailwind-merge'
      ]
    },
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'confirm-contract-fixture',
        resolveId: (id) => (id === '/@confirm-probe' ? '\0confirm-probe' : undefined),
        load: (id) => (id === '\0confirm-probe' ? { code: probeSource, map: null } : undefined),
        async transform(code, id) {
          if (id !== '\0confirm-probe') return
          const { transformWithEsbuild } = await import('vite')
          return transformWithEsbuild(code, 'confirm-probe.tsx', { loader: 'tsx', jsx: 'automatic' })
        },
        configureServer(vite) {
          vite.middlewares.use('/__confirm_probe__', async (_request, response) => {
            const html = await vite.transformIndexHtml(
              '/__confirm_probe__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/@confirm-probe"></script></body></html>'
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
  page = await browser.newPage()
  page.on('pageerror', (error) => console.error(error.message))
  // cn shares a module with platform formatting; provide only that host fact.
  // No business API or persistence is replaced in this component fixture.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'platform', { value: { os: 'darwin' } })
    const events: Record<string, unknown>[] = []
    Reflect.set(window, 'confirmationEscapeDiagnostics', events)
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape')
          queueMicrotask(() => {
            events.push({ defaultPrevented: event.defaultPrevented, focused: document.activeElement?.outerHTML })
          })
      },
      true
    )
  })
  await page.goto(`${server.resolvedUrls!.local[0]}__confirm_probe__`)
  await expect(page.getByRole('button', { name: 'queue pair', exact: true })).toBeVisible()
})

test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus && page && !page.isClosed()) {
    await test.info().attach('confirmation-failure-state', {
      body: JSON.stringify(
        await page.evaluate(() => ({
          focused: document.activeElement?.outerHTML,
          documentFocused: document.hasFocus(),
          escapeEvents: Reflect.get(window, 'confirmationEscapeDiagnostics'),
          results: window.confirmProbe?.results,
          dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).map((element) => ({
            role: element.getAttribute('role'),
            state: element.getAttribute('data-state'),
            hidden: element.getAttribute('aria-hidden'),
            animation: getComputedStyle(element).animationName,
            duration: getComputedStyle(element).animationDuration
          }))
        })),
        null,
        2
      ),
      contentType: 'application/json'
    })
  }
  await page?.close()
})

test('C3 FIFO keeps both resolvers, trims prompt input, and restores the initiating focus', async () => {
  const trigger = page.getByRole('button', { name: 'queue pair', exact: true })
  await trigger.click()
  const first = page.getByRole('alertdialog', { name: 'first', exact: true })
  await expect(first).toHaveAttribute('data-ui-overlay', 'alert-dialog')
  await expect(first).toHaveAccessibleDescription('first description')
  await expect(page.getByRole('alertdialog')).toHaveCount(1)
  await first.getByRole('button', { name: '确认', exact: true }).click()
  const second = page.getByRole('alertdialog', { name: 'second', exact: true })
  await expect(second).toHaveAccessibleDescription('second description')
  const input = second.getByRole('textbox')
  await expect(input).toBeFocused()
  expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 8])
  await input.fill('  renamed  ')
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.evaluate(() => window.confirmProbe.results))
    .toEqual([
      ['first', true],
      ['second', 'renamed']
    ])
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
})

test('C3 prompt forbids blank approval and Enter used to confirm an IME candidate does not submit', async () => {
  await page.getByRole('button', { name: 'rename', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'rename', exact: true })
  const input = dialog.getByRole('textbox')
  await input.fill('   ')
  await expect(dialog.getByRole('button', { name: '确认', exact: true })).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await input.fill('候选词')
  await input.dispatchEvent('compositionstart')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => window.confirmProbe.results)).toEqual([])
  await input.dispatchEvent('compositionend', { data: '候选词' })
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.confirmProbe.results)).toEqual([['prompt', '候选词']])
})

test('C3 duplicate operation keys independently cancel and scope changes cancel only the old owner', async () => {
  await page.getByRole('button', { name: 'owner confirm', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: 'owned one', exact: true })).toBeVisible()
  await page.evaluate(() => window.confirmProbe.setOwner('two'))
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.confirmProbe.results)).toEqual([['owner', false]])
  expect(await page.evaluate(() => window.confirmProbe.ownerSignal.aborted)).toBe(false)
  await page.getByRole('button', { name: 'owner confirm', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: 'owned two', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    void window.confirmProbe
      .confirm({ title: 'keyed', operationKey: 'note:1:delete' })
      .then((value) => window.confirmProbe.results.push(['key-first', value]))
    void window.confirmProbe
      .confirm({ title: 'keyed', operationKey: 'note:1:delete' })
      .then((value) => window.confirmProbe.results.push(['key-duplicate', value]))
  })
  await expect(page.getByRole('alertdialog', { name: 'keyed', exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  // Initial focus is the safe cancel action; Enter must not authorize a deletion.
  await expect
    .poll(() => page.evaluate(() => window.confirmProbe.results.slice(-2)))
    .toEqual([
      ['key-duplicate', false],
      ['key-first', false]
    ])
})

test('C3 host disposal safely settles active and waiting requests, clears pointer lock, and remounts', async () => {
  await page.getByRole('button', { name: 'queue pair', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: 'first', exact: true })).toBeVisible()
  await page.evaluate(() => window.confirmProbe.setHost(false))
  await expect
    .poll(() => page.evaluate(() => window.confirmProbe.results))
    .toEqual([
      ['first', false],
      ['second', null]
    ])
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
  await page.evaluate(() => window.confirmProbe.setHost(true))
  await page.getByRole('button', { name: 'owner confirm', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.confirmProbe.results.at(-1))).toEqual(['owner', false])
})

test('C3 nested Escape closes one layer and the removed trigger restores a workspace action', async () => {
  await page.getByRole('button', { name: 'open outer', exact: true }).click()
  const outer = page.getByRole('dialog', { name: 'outer', exact: true })
  const nestedTrigger = outer.getByRole('button', { name: 'nested confirm', exact: true })
  await nestedTrigger.click()
  await expect(page.getByRole('alertdialog', { name: 'nested', exact: true })).toBeVisible()
  await expect(page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(outer).toBeVisible()
  await expect(nestedTrigger).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(outer).toHaveCount(0)
  await page.getByRole('button', { name: 'queue pair', exact: true }).click()
  await page.evaluate(() => window.confirmProbe.removeTrigger())
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog', { name: 'second', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'safe action', exact: true })).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
})

test('C3 close and cancellation controls follow the active English locale', async () => {
  await page.evaluate(() => window.confirmProbe.language('en'))
  await page.getByRole('button', { name: 'owner confirm', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.confirmProbe.results)).toEqual([['owner', false]])
})

test('C3 mutation failure preserves text and explicit retry locks controls until the real write finishes', async () => {
  await page.getByRole('button', { name: 'recoverable rename', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'recoverable rename', exact: true })
  const input = dialog.getByRole('textbox')
  await input.fill('  preserved draft  ')
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('alert')).toContainText('controlled write failure')
  await expect(input).toHaveValue('  preserved draft  ')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(await page.evaluate(() => window.confirmProbe.results)).toEqual([])
  expect(await page.evaluate(() => window.confirmProbe.writes)).toEqual([])
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await expect(input).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '处理中…', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => window.confirmProbe.attempts)).toBe(2)
  await page.evaluate(() => window.confirmProbe.finishWrite())
  await expect.poll(() => page.evaluate(() => window.confirmProbe.results)).toEqual([['write', 'preserved draft']])
  expect(await page.evaluate(() => window.confirmProbe.writes)).toEqual(['preserved draft'])
  await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
})

test('C3 actual Electron cancellation, menu owner, and recoverable prompt reach real persistence', async () => {
  const app = await isolatedElectron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-confirm-e2e-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('today-view')).toBeVisible()
    await window.keyboard.press('ControlOrMeta+1')
    await window.keyboard.press('ControlOrMeta+n')
    const title = window.getByPlaceholder('笔记标题')
    await title.fill('C3 persisted cancellation')
    await expect
      .poll(() =>
        window.evaluate(() =>
          window.jiwei.notes.list({}).then((notes) => notes.find((note) => note.title === 'C3 persisted cancellation')?.id ?? null)
        )
      )
      .not.toBeNull()
    const note = await window.evaluate(() =>
      window.jiwei.notes.list({}).then((notes) => notes.find((item) => item.title === 'C3 persisted cancellation')!)
    )
    const row = window.locator(`[data-note-id="${note.id}"]`)
    await row.hover()
    await row.getByRole('button', { name: '笔记操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '删除', exact: true }).click()
    await expect(window.getByRole('alertdialog')).toHaveAttribute('data-ui-overlay', 'alert-dialog')
    await window.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
    expect(await window.evaluate((id) => window.jiwei.notes.get(id), note.id)).toMatchObject({ deletedAt: null })
    const openDelete = async () => {
      await window.locator('main header').getByRole('button', { name: '更多', exact: true }).click()
      await window.getByRole('menuitem', { name: '删除', exact: true }).click()
      await expect(window.getByRole('alertdialog')).toBeVisible()
    }
    await openDelete()
    await window.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
    expect(await window.evaluate((id) => window.jiwei.notes.get(id), note.id)).toMatchObject({
      id: note.id,
      deletedAt: null,
      title: 'C3 persisted cancellation'
    })
    await openDelete()
    await window.keyboard.press('Escape')
    expect(await window.evaluate((id) => window.jiwei.notes.get(id), note.id)).toMatchObject({ deletedAt: null })
    await openDelete()
    await window.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect
      .poll(() =>
        window.evaluate(
          (id) => window.jiwei.trash.list().then((items) => items.some((item) => item.type === 'note' && item.id === id)),
          note.id
        )
      )
      .toBe(true)
    await expect(window.locator('body')).not.toHaveCSS('pointer-events', 'none')

    // Only the controlled first failure and delay are injected. The successful
    // attempt invokes the original registered IPC handler and real SQLite write.
    await app.evaluate(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => unknown
      const channel = 'categories:create'
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)!
      const state = { calls: 0, release: () => {}, restore: () => {} }
      const held = new Promise<void>((resolve) => {
        state.release = resolve
      })
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        state.calls += 1
        if (state.calls === 1) throw new Error('category persistence rejected')
        await held
        return original(...args)
      })
      state.restore = () => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, original)
      }
      Reflect.set(globalThis, '__jiweiConfirmWriteGate', state)
    })
    await window.getByRole('button', { name: '新建分类', exact: true }).click()
    const category = window.getByRole('alertdialog', { name: '新建分类', exact: true })
    const input = category.getByRole('textbox')
    await input.fill('C3 retained category draft')
    await category.getByRole('button', { name: '新建', exact: true }).click()
    await expect(category.getByRole('alert')).toContainText('category persistence rejected')
    await expect(input).toHaveValue('C3 retained category draft')
    expect(
      await window.evaluate(() =>
        window.jiwei.categories.list('note').then((items) => items.filter((item) => item.name === 'C3 retained category draft').length)
      )
    ).toBe(0)
    await category.getByRole('button', { name: '重试', exact: true }).click()
    await expect(input).toBeDisabled()
    await expect(category.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
    await window.keyboard.press('Escape')
    await expect(category).toBeVisible()
    expect(await app.evaluate(() => Reflect.get(globalThis, '__jiweiConfirmWriteGate').calls)).toBe(2)
    await app.evaluate(() => Reflect.get(globalThis, '__jiweiConfirmWriteGate').release())
    await expect(category).toHaveCount(0)
    await expect
      .poll(() =>
        window.evaluate(() =>
          window.jiwei.categories.list('note').then((items) => items.filter((item) => item.name === 'C3 retained category draft').length)
        )
      )
      .toBe(1)
    await app.evaluate(() => Reflect.get(globalThis, '__jiweiConfirmWriteGate').restore())
    await expect(window.locator('body')).not.toHaveCSS('pointer-events', 'none')
  } finally {
    await app.close()
  }
})
