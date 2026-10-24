// Current scope: shared/non-AI Settings shell and persistence contracts.
// Superseded AI migration cases remain verbatim in external rework evidence.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { isolatedElectron as electron } from './fixtures/isolateElectron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launch = (userData: string): Promise<ElectronApplication> =>
  electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })

async function settings(page: Page, tab: string): Promise<void> {
  await page.waitForSelector('nav')
  await page.keyboard.press('Meta+,')
  await page.getByRole('dialog').getByRole('tab', { name: tab, exact: true }).click()
}



/** Observe the first frame used by SC-005's existing Settings readiness condition. */
async function armSettingsFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as typeof window & {
      settingsFirstReadyFocus?: Promise<{ selected: string; focused: boolean; visibleInNav: boolean }>
    }
    state.settingsFirstReadyFocus = new Promise((resolve, reject) => {
      const started = performance.now()
      const frame = (): void => {
        const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
          (element) =>
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden' &&
            element.querySelectorAll('nav button, [role="tab"]').length >= 16
        )
        if (dialog) {
          const selected = dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!
          const nav = selected.closest('nav')!
          const bounds = selected.getBoundingClientRect()
          const viewport = nav.getBoundingClientRect()
          resolve({
            selected: selected.textContent!.trim(),
            focused: document.activeElement === selected,
            visibleInNav: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom
          })
        } else if (performance.now() - started > 10_000) reject(new Error('Settings did not become ready'))
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  })
}

const firstSettingsFocus = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as typeof window & {
          settingsFirstReadyFocus: Promise<{ selected: string; focused: boolean; visibleInNav: boolean }>
        }
      ).settingsFirstReadyFocus
  )

test('Settings initial focus is on the visible selected tab at the first ready frame, including a lower tab on reopen', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), 'jiwei-settings-first-focus-')))
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await armSettingsFocus(page)
    await page.keyboard.press('Meta+,')
    expect(await firstSettingsFocus(page)).toEqual({ selected: '通用', focused: true, visibleInNav: true })
    const about = page.getByRole('dialog').getByRole('tab', { name: '关于', exact: true })
    await about.click()
    await expect(about).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await armSettingsFocus(page)
    await page.keyboard.press('Meta+,')
    expect(await firstSettingsFocus(page)).toEqual({ selected: '关于', focused: true, visibleInNav: true })
    await expect(page.getByRole('dialog').getByRole('tab', { name: '关于', exact: true })).toBeFocused()
  } finally {
    await app.close()
  }
})

test('external Settings entry selects and focuses its requested tab in the first ready frame after another tab was closed', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), 'jiwei-settings-entry-focus-')))
  try {
    const page = await app.firstWindow()
    await settings(page, '关于')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page
      .getByTestId('nav-rail')
      .getByRole('button', { name: /积微助手/ })
      .click()
    await page.getByTestId('web-mode-picker').click()
    await armSettingsFocus(page)
    await page.getByTestId('web-mode-settings').click()
    expect(await firstSettingsFocus(page)).toEqual({ selected: '联网搜索', focused: true, visibleInNav: true })
    await expect(page.getByRole('dialog').getByRole('tab', { name: '联网搜索', exact: true })).toBeFocused()
  } finally {
    await app.close()
  }
})

/** Gate the real IPC handler. Successful calls always reach the real service. */
async function gate(app: ElectronApplication, channel: string, mode: 'hold' | 'fail' | 'response'): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channel, mode }) => {
      type Handler = (...args: unknown[]) => unknown
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)!
      const state = { calls: 0, fail: mode === 'fail', release: null as (() => void) | null, restore: () => {} }
      const wait = new Promise<void>((resolve) => {
        state.release = resolve
      })
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const call = ++state.calls
        if (state.fail) throw new Error('settings persistence rejected')
        if (mode === 'hold') await wait
        const result = await original(...args)
        if (mode === 'response' && call === 1) await wait
        return result
      })
      state.restore = () => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, original)
      }
      Reflect.set(globalThis, '__jiweiSettingsGate', state)
    },
    { channel, mode }
  )
}

const release = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => {
    Reflect.get(globalThis, '__jiweiSettingsGate').fail = false
    Reflect.get(globalThis, '__jiweiSettingsGate').release?.()
  })

test('two real renderer clients retain different review leaves despite a delayed old response and restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-settings-two-clients-'))
  let app = await launch(userData)
  try {
    const first = await app.firstWindow()
    await settings(first, '学习')
    const newWindow = app.waitForEvent('window')
    await app.evaluate(
      async ({ BrowserWindow }, preload) => {
        const primary =
          BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html')) ??
          BrowserWindow.getAllWindows()[0]
        const second = new BrowserWindow({
          show: true,
          webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
        })
        await second.loadURL(primary.webContents.getURL())
      },
      join(process.cwd(), 'out/preload/index.js')
    )
    const second = await newWindow
    expect(await second.evaluate(() => typeof window.jiwei), 'the second renderer must load the real IPC preload').toBe('object')
    await settings(second, '学习')
    await gate(app, 'settings:set', 'response')
    await first.getByRole('dialog').getByRole('radio', { name: '30', exact: true }).click()
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, '__jiweiSettingsGate').calls)).toBe(1)
    await second.getByRole('dialog').getByRole('radio', { name: '95%', exact: true }).click()
    await expect
      .poll(() => first.evaluate(() => window.jiwei.settings.get().then((settings) => settings.review)))
      .toEqual({ newPerDay: 30, retention: 0.95 })
    await release(app)
    await expect(first.getByRole('dialog').getByRole('radio', { name: '95%', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(second.getByRole('dialog').getByRole('radio', { name: '30', exact: true })).toHaveAttribute('aria-checked', 'true')
    await app.close()
    app = await launch(userData)
    const reopened = await app.firstWindow()
    await settings(reopened, '学习')
    await expect(reopened.getByRole('dialog').getByRole('radio', { name: '30', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(reopened.getByRole('dialog').getByRole('radio', { name: '95%', exact: true })).toHaveAttribute('aria-checked', 'true')
  } finally {
    await app.close()
  }
})

test('closing Settings releases its backdrop and modal locks when the dialog disappears', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), 'jiwei-settings-close-locks-')))
  try {
    const page = await app.firstWindow()
    await settings(page, '通用')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const closed = await page.evaluate(() => ({
      backdrops: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
      pointerEvents: getComputedStyle(document.body).pointerEvents,
      scrollLocked: document.body.hasAttribute('data-scroll-locked'),
      contentHidden: document.getElementById('root')?.getAttribute('aria-hidden')
    }))
    expect(closed).toEqual({ backdrops: 0, pointerEvents: 'auto', scrollLocked: false, contentHidden: null })
    await page.keyboard.press('Meta+1')
    await page.keyboard.press('Meta+n')
    await page.getByPlaceholder('笔记标题').fill('SETTINGS_CLOSED_CONTENT_IS_USABLE')
    await page.getByPlaceholder('笔记标题').blur()
    await expect
      .poll(() => page.evaluate(() => window.jiwei.notes.list({}).then((notes) => notes.map((note) => note.title))))
      .toContain('SETTINGS_CLOSED_CONTENT_IS_USABLE')
  } finally {
    await app.close()
  }
})

test('closing Command releases its backdrop and modal locks before the next action', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), 'jiwei-command-close-locks-')))
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await page.keyboard.press('Meta+k')
    await expect(page.locator('[cmdk-input]')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const closed = await page.evaluate(() => ({
      backdrops: document.querySelectorAll('[data-slot="dialog-overlay"]').length,
      pointerEvents: getComputedStyle(document.body).pointerEvents,
      scrollLocked: document.body.hasAttribute('data-scroll-locked'),
      contentHidden: document.getElementById('root')?.getAttribute('aria-hidden')
    }))
    expect(closed).toEqual({ backdrops: 0, pointerEvents: 'auto', scrollLocked: false, contentHidden: null })
    await page.keyboard.press('Meta+,')
    await expect(page.getByRole('dialog').getByRole('tab', { name: '通用', exact: true })).toBeFocused()
  } finally {
    await app.close()
  }
})
