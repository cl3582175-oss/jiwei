import { test, expect, chromium, type Browser, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { isolatedElectron } from './fixtures/isolateElectron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { ShadcnProbe } from './fixtures/shadcn-components'

async function launchUi(language = 'zh-CN'): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await isolatedElectron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-shadcn-ui-'))}`],
    env: { ...process.env, JIWEI_LANG: language, JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('today-view')).toBeVisible()
  return { app, page }
}

async function contrast(locator: Locator, property: 'color' | 'borderTopColor' | 'outlineColor' = 'color'): Promise<number> {
  return locator.evaluate((element, property) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data).map((n, index) => (index === 3 ? n / 255 : n))
    }
    const over = (top: number[], bottom: number[]): number[] => {
      const alpha = top[3] + bottom[3] * (1 - top[3])
      return [0, 1, 2].map((index) => (top[index] * top[3] + bottom[index] * bottom[3] * (1 - top[3])) / alpha).concat(alpha)
    }
    const layers: number[][] = []
    for (let node: Element | null = element; node; node = node.parentElement) layers.push(rgba(getComputedStyle(node).backgroundColor))
    const background = layers.reverse().reduce((result, layer) => over(layer, result), [255, 255, 255, 1])
    const foreground = over(rgba(getComputedStyle(element)[property]), background)
    const luminance = (color: number[]): number => {
      const rgb = color
        .slice(0, 3)
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    }
    const a = luminance(foreground),
      b = luminance(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }, property)
}

async function finishVisualTransitions(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
  })
}

test('C2 baseline gap: real settings portal declares its overlay and vertical manual tabs', async () => {
  const { app, page } = await launchUi()
  try {
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(dialog).toBeVisible()
    await expect.soft(dialog).toHaveAttribute('data-ui-overlay', 'dialog', { timeout: 1000 })
    await expect.soft(dialog.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical', { timeout: 1000 })
    await expect.soft(dialog.getByRole('tab')).toHaveCount(16, { timeout: 1000 })
    if ((await dialog.getByRole('tab').count()) === 16) {
      const first = dialog.getByRole('tab').nth(0)
      const second = dialog.getByRole('tab').nth(1)
      await first.click()
      await first.focus()
      await page.keyboard.press('ArrowDown')
      await expect(second).toBeFocused()
      await expect(first, 'manual tabs keep the active panel while only moving focus').toHaveAttribute('aria-selected', 'true')
      await expect(second).toHaveAttribute('aria-selected', 'false')
      await page.keyboard.press('Enter')
      await expect(second).toHaveAttribute('aria-selected', 'true')
    }
  } finally {
    await app.close()
  }
})

test('C2 settings reopens with the selected lower tab focused and visible at normal and minimum sizes', async () => {
  const { app, page } = await launchUi('en')
  try {
    for (const [width, height] of [
      [1440, 900],
      [1000, 640]
    ]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
      for (const name of ['About', 'Browser']) {
        await page.keyboard.press('ControlOrMeta+,')
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
        await dialog.getByRole('tab', { name, exact: true }).click()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await page.keyboard.press('ControlOrMeta+,')
        const selected = dialog.getByRole('tab', { name, exact: true })
        await expect(selected).toHaveAttribute('aria-selected', 'true')
        await expect(selected).toBeFocused()
        await finishVisualTransitions(dialog)
        const geometry = await selected.evaluate((element) => {
          const tab = element.getBoundingClientRect()
          const nav = element.closest('nav')!.getBoundingClientRect()
          const modal = element.closest('[role="dialog"]')!.getBoundingClientRect()
          return {
            top: tab.top,
            bottom: tab.bottom,
            clipTop: Math.max(nav.top, modal.top, 0),
            clipBottom: Math.min(nav.bottom, modal.bottom, innerHeight)
          }
        })
        expect(geometry.top, `${name} focus must be visible after reopening at ${width}×${height}`).toBeGreaterThanOrEqual(
          geometry.clipTop - 1
        )
        expect(geometry.bottom, `${name} focus must be visible after reopening at ${width}×${height}`).toBeLessThanOrEqual(
          geometry.clipBottom + 1
        )
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
      }
    }
  } finally {
    await app.close()
  }
})

test('C2 baseline gap: real Command portal and input use the shared overlay contract', async () => {
  const { app, page } = await launchUi()
  try {
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.locator('[cmdk-input]')
    await expect(input).toBeFocused()
    await input.fill('无匹配的合约测试笔记')
    await expect(input).toHaveValue('无匹配的合约测试笔记')
    await expect.soft(page.getByRole('dialog')).toHaveAttribute('data-ui-overlay', 'command', { timeout: 1000 })
    await expect.soft(input).toHaveAttribute('data-slot', 'command-input', { timeout: 1000 })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
  } finally {
    await app.close()
  }
})

test('C2 baseline gap: real note menu declares its overlay and restores its trigger focus', async () => {
  const { app, page } = await launchUi()
  try {
    await page.keyboard.press('ControlOrMeta+1')
    await page.keyboard.press('ControlOrMeta+n')
    await expect(page.getByPlaceholder('笔记标题')).toBeVisible()
    const trigger = page.locator('main header').getByRole('button', { name: '更多', exact: true })
    await trigger.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await expect.soft(page.getByRole('menu')).toHaveAttribute('data-ui-overlay', 'menu', { timeout: 1000 })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
  } finally {
    await app.close()
  }
})

test('SC-002 real App: 12 palette/mode/language combinations, local PaletteCard and body Portal', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchUi()
  const measurements: Record<string, unknown>[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    for (const palette of ['qinglu', 'celadon', 'dunhuang'] as const)
      for (const theme of ['light', 'dark'] as const)
        for (const language of ['zh-CN', 'en'] as const)
          await test.step(`${palette}/${theme}/${language}`, async () => {
            await page.evaluate((settings) => window.jiwei.settings.set(settings), { palette, theme, language })
            await expect(page.locator('html')).toHaveAttribute('data-palette', palette)
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
            await page.keyboard.press('ControlOrMeta+,')
            const dialog = page.getByRole('dialog', { name: language === 'zh-CN' ? '设置' : 'Settings', exact: true })
            await expect(dialog).toHaveAttribute('data-ui-overlay', 'dialog')
            const selectedTab = dialog
              .getByRole('tablist', { name: language === 'zh-CN' ? '设置' : 'Settings', exact: true })
              .getByRole('tab', { selected: true })
            await expect(selectedTab).toBeFocused()
            await finishVisualTransitions(dialog)
            const tabFocus = await selectedTab.evaluate((element) => ({
              visible: element.matches(':focus-visible'),
              width: parseFloat(getComputedStyle(element).outlineWidth),
              style: getComputedStyle(element).outlineStyle
            }))
            expect(tabFocus.visible).toBe(true)
            expect(tabFocus.width).toBeGreaterThan(0)
            expect(tabFocus.style).not.toBe('none')
            const tabFocusContrast = await contrast(selectedTab, 'outlineColor')
            expect.soft(tabFocusContrast, `${palette}/${theme}/${language} selected tab focus contrast`).toBeGreaterThanOrEqual(3)
            await dialog.getByRole('tab', { name: language === 'zh-CN' ? '外观' : 'Appearance', exact: true }).click()
            const previews = dialog.locator('[data-palette][data-theme]')
            await expect(previews).toHaveCount(3)
            const tokens = await previews.evaluateAll((elements) =>
              elements.map((element) => {
                const style = getComputedStyle(element)
                return {
                  palette: element.getAttribute('data-palette'),
                  theme: element.getAttribute('data-theme'),
                  primary: style.getPropertyValue('--primary').trim(),
                  accent: style.getPropertyValue('--accent').trim(),
                  background: style.backgroundColor
                }
              })
            )
            for (const preview of tokens) {
              expect(preview.theme).toBe(theme)
              expect(preview.primary, `${preview.palette} must resolve semantic primary inside its own PaletteCard`).not.toBe('')
              expect(preview.primary).toBe(preview.accent)
            }
            expect(new Set(tokens.map((token) => token.primary)).size, 'PaletteCards keep their own palettes').toBe(3)
            const portal = await dialog.evaluate((element) => ({
              outsideRoot: !document.getElementById('root')?.contains(element),
              primary: getComputedStyle(element).getPropertyValue('--primary').trim(),
              uiAccent: getComputedStyle(element).getPropertyValue('--ui-accent').trim(),
              legacyMuted: getComputedStyle(element).getPropertyValue('--muted').trim(),
              uiMuted: getComputedStyle(element).getPropertyValue('--ui-muted').trim()
            }))
            expect(portal.outsideRoot).toBe(true)
            expect(portal.primary).toBe(tokens.find((token) => token.palette === palette)!.primary)
            expect(portal.uiAccent).not.toBe('')
            expect(portal.uiMuted).not.toBe('')
            expect(portal.uiMuted).not.toBe(portal.legacyMuted)
            const titleContrast = await contrast(
              dialog.getByRole('heading', { name: language === 'zh-CN' ? '设置' : 'Settings', exact: true })
            )
            const mutedContrast = await contrast(
              dialog.getByText(
                language === 'zh-CN'
                  ? '取自中国传统绘画与器物的三套配色'
                  : 'Three palettes drawn from classical Chinese painting and ceramics',
                { exact: true }
              )
            )
            expect.soft(titleContrast, `${palette}/${theme}/${language} normal text contrast`).toBeGreaterThanOrEqual(4.5)
            expect.soft(mutedContrast, `${palette}/${theme}/${language} description contrast`).toBeGreaterThanOrEqual(4.5)
            await dialog.getByRole('tab', { name: language === 'zh-CN' ? '关于我' : 'About me', exact: true }).click()
            const field = page.getByRole('textbox', { name: language === 'zh-CN' ? '我是' : 'I am', exact: true })
            await field.focus()
            await expect(field).toBeFocused()
            await finishVisualTransitions(field)
            const inputFocusDecoration = await field.evaluate((element) => {
              const style = getComputedStyle(element)
              return { border: style.borderTopColor, outline: style.outlineStyle, shadow: style.boxShadow }
            })
            expect.soft(inputFocusDecoration).toEqual({ border: 'rgba(0, 0, 0, 0)', outline: 'none', shadow: 'none' })
            measurements.push({
              palette,
              theme,
              language,
              tokens,
              portal,
              titleContrast,
              mutedContrast,
              inputFocusDecoration,
              tabFocusContrast
            })
            await page.keyboard.press('Escape')
            await expect(page.getByRole('dialog')).toHaveCount(0)
          })
    expect(measurements).toHaveLength(12)
    expect(errors).toEqual([])
  } finally {
    const path = test.info().outputPath('appearance-combinations.json')
    writeFileSync(path, JSON.stringify({ measurements, errors }, null, 2))
    await test.info().attach('appearance-combinations', { path, contentType: 'application/json' })
    await app.close()
  }
})

test('C1 real profile field connects its accessible label, help and validation error to the control', async () => {
  const { app, page } = await launchUi()
  try {
    const initialProfile = await page.evaluate(() => window.jiwei.memory.profile())
    await page.keyboard.press('ControlOrMeta+,')
    await page.getByRole('dialog').getByRole('tab', { name: '关于我', exact: true }).click()
    const field = page.getByRole('textbox', { name: '我是', exact: true })
    await expect(field).toBeVisible()
    await expect(field).toHaveJSProperty('tagName', 'TEXTAREA')
    await expect(field).toHaveAccessibleDescription(/已用 0.*500/)
    await field.fill('文'.repeat(501))
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(field).toHaveAccessibleDescription(/超出字符限制/)
    const links = await field.evaluate((element) =>
      (element.getAttribute('aria-describedby') || '').split(/\s+/).map((id) => ({ id, exists: !!document.getElementById(id) }))
    )
    expect(links.length).toBeGreaterThanOrEqual(2)
    expect(links.every((link) => link.exists)).toBe(true)
    expect(await page.evaluate(() => window.jiwei.memory.profile())).toEqual(initialProfile)
    await field.fill('有效档案')
    await field.blur()
    await expect.poll(() => page.evaluate(() => window.jiwei.memory.profile().then((profile) => profile.role))).toBe('有效档案')
    await expect(field).not.toHaveAttribute('aria-invalid', 'true')
    await expect(field).toHaveAccessibleDescription(/已用 4.*500/)
  } finally {
    await app.close()
  }
})

test('C1 system appearance updates the open Settings portal and local palette previews', async () => {
  const { app, page } = await launchUi()
  try {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(() => window.jiwei.settings.set({ theme: 'system', palette: 'qinglu' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('tab', { name: '外观', exact: true }).click()
    const previews = dialog.locator('[data-palette][data-theme]')
    await expect(previews).toHaveCount(3)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    for (const preview of await previews.all()) await expect(preview).toHaveAttribute('data-theme', 'dark')
    const dark = await dialog.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      primary: getComputedStyle(element).getPropertyValue('--primary').trim()
    }))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    for (const preview of await previews.all()) await expect(preview).toHaveAttribute('data-theme', 'light')
    const light = await dialog.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      primary: getComputedStyle(element).getPropertyValue('--primary').trim()
    }))
    expect(dark.background).not.toBe(light.background)
    expect(dark.primary).not.toBe(light.primary)
  } finally {
    await app.close()
  }
})

test('SC-002 real settings remain reachable at the minimum 1000×640 window in English', async () => {
  const { app, page } = await launchUi('en')
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect(dialog).toBeVisible()
    await finishVisualTransitions(dialog)
    const bounds = await dialog.boundingBox()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(44)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    for (const name of ['General', 'Appearance', 'About']) {
      const tab = dialog.getByRole('tab', { name, exact: true })
      await tab.scrollIntoViewIfNeeded()
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
    }
    await page.screenshot({ path: test.info().outputPath('minimum-window-english.png') })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test.describe('production component contracts (fixture, not app capability evidence)', () => {
  let server: ViteDevServer
  let browser: Browser
  let page: Page
  const errors: string[] = []
  test.beforeAll(async () => {
    server = await createServer({
      configFile: false,
      cacheDir: resolve('node_modules/.vite/shadcn-component-contract'),
      optimizeDeps: { entries: ['e2e/fixtures/shadcn-components.html'] },
      plugins: [react(), tailwindcss()],
      resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
      server: { host: '127.0.0.1', port: 0 }
    })
    await server.listen()
    browser = await chromium.launch({ channel: 'chrome' })
  })
  test.beforeEach(async () => {
    errors.length = 0
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/shadcn-components.html`)
    await expect(page.getByRole('heading', { name: 'Production component contract fixture' })).toBeVisible()
  })
  test.afterEach(async () => {
    await test.info().attach('fixture-page-errors', { body: JSON.stringify(errors), contentType: 'application/json' })
    if (test.info().status !== test.info().expectedStatus && !page.isClosed()) {
      const screenshot = test.info().outputPath('fixture-failure.png')
      await page.screenshot({ path: screenshot, fullPage: true })
      await test.info().attach('fixture-failure', { path: screenshot, contentType: 'image/png' })
      const snapshot = test.info().outputPath('fixture-failure.txt')
      writeFileSync(snapshot, await page.locator('body').ariaSnapshot())
      await test.info().attach('fixture-failure-state', { path: snapshot, contentType: 'text/plain' })
    }
    await page?.close()
    expect(errors, 'production component fixture runtime errors').toEqual([])
  })
  test.afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  test('C1 Button keeps secondary default, native type, 34/28px sizes, disabled state and ref', async () => {
    const button = page.getByTestId('default-button')
    await expect(button).toHaveAttribute('type', 'button')
    await expect(button).toHaveAttribute('data-slot', 'button')
    await expect(button).toHaveCSS('height', '34px')
    await expect(page.getByTestId('icon-button')).toHaveCSS('height', '34px')
    await expect(page.getByTestId('small-button')).toHaveCSS('height', '28px')
    await expect(page.getByTestId('small-icon-button')).toHaveCSS('height', '28px')
    await expect(button).toHaveCSS('border-top-width', '0px')
    await expect(page.getByRole('button', { name: '显式描边', exact: true })).toHaveCSS('border-top-width', '1px')
    await expect(page.getByRole('button', { name: '透明按钮', exact: true })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.getByRole('button', { name: '明确提交', exact: true })).toHaveCSS('box-shadow', 'none')
    await page.mouse.move(1400, 800, { steps: 8 })
    await page.screenshot({ path: test.info().outputPath('buttons-normal.png') })
    await button.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(button).toBeFocused()
    const focus = await button.evaluate((element) => {
      const style = getComputedStyle(element)
      return { visible: element.matches(':focus-visible'), border: style.border, outline: style.outline, boxShadow: style.boxShadow }
    })
    expect(focus.visible).toBe(true)
    expect(focus.boxShadow !== 'none' || !focus.outline.includes(' none '), 'keyboard focus retains a visible indicator').toBe(true)
    writeFileSync(test.info().outputPath('button-keyboard-focus.json'), JSON.stringify(focus, null, 2))
    await page.screenshot({ path: test.info().outputPath('buttons-keyboard-focus.png') })
    await button.click()
    await expect(page.getByTestId('form-submits')).toHaveText('0')
    await page.getByRole('button', { name: '明确提交', exact: true }).click()
    await expect(page.getByTestId('form-submits')).toHaveText('1')
    await expect(page.getByRole('button', { name: '不可用危险操作' })).toBeDisabled()
    expect(await page.evaluate(() => (window as typeof window & { shadcnProbe: ShadcnProbe }).shadcnProbe.refs())).toMatchObject({
      button: true,
      input: true
    })
  })

  test('C1 Input preserves controlled/uncontrolled values, native constraints, ref and selection', async () => {
    await page.getByLabel('受控字段', { exact: true }).fill('受控新值')
    await expect(page.getByLabel('受控字段', { exact: true })).toHaveValue('受控新值')
    await page.evaluate(() => window.shadcnProbe.focusInput())
    expect(await page.evaluate(() => window.shadcnProbe.refs())).toMatchObject({ input: true, selection: [1, 3] })
    await expect(page.getByLabel('受控字段', { exact: true })).toBeFocused()
    await expect(page.getByLabel('非受控字段', { exact: true })).toHaveValue('默认文字')
    await page.getByLabel('非受控字段', { exact: true }).fill('原生默认值可编辑')
    await expect(page.getByLabel('非受控字段', { exact: true })).toHaveValue('原生默认值可编辑')
    const number = page.getByLabel('数值字段')
    await expect(number).toHaveAttribute('type', 'number')
    await number.fill('11')
    expect(await number.evaluate((element: HTMLInputElement) => element.validity.rangeOverflow)).toBe(true)
    await expect(page.getByLabel('日期字段')).toHaveValue('2026-10-23')
    await expect(page.getByLabel('日期字段')).toHaveAttribute('type', 'date')
    await page
      .getByLabel('文件字段')
      .setInputFiles({ name: 'contract.txt', mimeType: 'text/plain', buffer: Buffer.from('real File input') })
    expect(await page.getByLabel('文件字段').evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe('contract.txt')
  })

  test('C5 Composer keeps Shift+Enter, IME, failed-send draft and edits during a pending send', async () => {
    const input = page.getByRole('textbox', { name: '真实 Composer 输入', exact: true })
    await input.fill('第一行')
    await input.press('Shift+Enter')
    await expect(input).toHaveValue('第一行\n')
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
    expect(await page.evaluate(() => window.shadcnProbe.sends)).toEqual([])
    await input.fill('组合输入候选')
    await input.dispatchEvent('compositionstart', { data: '组' })
    // Match a real IME's native composing flag; Playwright press() alone emits
    // a non-composing keyboard event even after synthetic compositionstart.
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
    expect(await page.evaluate(() => window.shadcnProbe.sends)).toEqual([])
    await input.dispatchEvent('compositionend', { data: '组合输入候选' })
    await page.evaluate(() => window.shadcnProbe.setSendMode('reject'))
    await input.fill('失败后保留草稿')
    await input.press('Enter')
    await expect.poll(() => page.evaluate(() => window.shadcnProbe.sends)).toEqual(['失败后保留草稿'])
    await expect(input).toHaveValue('失败后保留草稿')
    await page.evaluate(() => window.shadcnProbe.setSendMode('deferred'))
    await input.fill('发送中的旧草稿')
    await input.press('Enter')
    await expect.poll(() => page.evaluate(() => window.shadcnProbe.sends)).toHaveLength(2)
    await input.press('Enter')
    expect(await page.evaluate(() => window.shadcnProbe.sends)).toHaveLength(2)
    await input.fill('发送期间的新草稿')
    await page.evaluate(() => window.shadcnProbe.finishSend())
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    await expect(input).toHaveValue('发送期间的新草稿')
  })

  test('C4 controlled Segmented exposes real radios and refuses to clear the selected option', async () => {
    const first = page.getByRole('radio', { name: '第一选择', exact: true })
    const second = page.getByRole('radio', { name: '第二选择', exact: true })
    await expect(first).toBeChecked()
    await expect(second).not.toBeChecked()
    await first.click()
    await expect(first).toBeChecked()
    await expect(page.getByTestId('segmented-choice')).toHaveText('first')
    await second.click()
    await expect(second).toBeChecked()
    await expect(first).not.toBeChecked()
    await expect(page.getByTestId('segmented-choice')).toHaveText('second')
    await second.click()
    await expect(second).toBeChecked()
    await expect(page.getByTestId('segmented-choice')).toHaveText('second')
  })

  test('SC-002 production button/menu/confirmation colors meet contrast in all 12 combinations', async () => {
    const measurements: Record<string, unknown>[] = []
    for (const palette of ['qinglu', 'celadon', 'dunhuang'])
      for (const theme of ['light', 'dark'])
        for (const language of ['zh-CN', 'en']) {
          await page.evaluate(
            async ({ palette, theme, language }) => {
              document.documentElement.dataset.palette = palette
              document.documentElement.dataset.theme = theme
              await window.shadcnProbe.setLanguage(language)
            },
            { palette, theme, language }
          )
          const normal = await contrast(page.getByTestId('default-button'))
          const primary = await contrast(page.getByRole('button', { name: '明确提交', exact: true }))
          const danger = await contrast(page.getByRole('button', { name: '危险操作', exact: true }))
          expect.soft(normal, `${palette}/${theme}/${language} secondary button text`).toBeGreaterThanOrEqual(4.5)
          expect.soft(primary, `${palette}/${theme}/${language} primary button text`).toBeGreaterThanOrEqual(4.5)
          expect.soft(danger, `${palette}/${theme}/${language} danger button text`).toBeGreaterThanOrEqual(4.5)
          await page.getByRole('button', { name: '打开真实菜单', exact: true }).click()
          const item = page.getByRole('menuitem', { name: '普通动作', exact: true })
          const menuText = await contrast(item)
          await item.hover()
          const highlightedText = await contrast(item)
          expect.soft(menuText, `${palette}/${theme}/${language} menu text`).toBeGreaterThanOrEqual(4.5)
          expect.soft(highlightedText, `${palette}/${theme}/${language} highlighted menu text`).toBeGreaterThanOrEqual(4.5)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('menu')).toHaveCount(0)
          await page.evaluate(() => window.shadcnProbe.startPrompt())
          const confirmationTitle = await contrast(
            page.getByRole('alertdialog').getByRole('heading', { name: '真实 prompt 合约', exact: true })
          )
          expect.soft(confirmationTitle, `${palette}/${theme}/${language} confirmation title`).toBeGreaterThanOrEqual(4.5)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('alertdialog')).toHaveCount(0)
          measurements.push({ palette, theme, language, normal, primary, danger, menuText, highlightedText, confirmationTitle })
        }
    expect(measurements).toHaveLength(12)
    const path = test.info().outputPath('component-contrast-combinations.json')
    writeFileSync(path, JSON.stringify(measurements, null, 2))
    await test.info().attach('component-contrast-combinations', { path, contentType: 'application/json' })
  })

  test('C2 nested menu closes before dialog, restores surviving focus and releases pointer events', async () => {
    const trigger = page.getByRole('button', { name: '打开真实 Dialog', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '真实 Dialog', exact: true })
    await expect(dialog).toHaveAttribute('data-ui-overlay', 'dialog')
    await expect(page.getByLabel('弹层字段')).toBeFocused()
    const menuTrigger = dialog.getByRole('button', { name: '对话框内菜单', exact: true })
    await menuTrigger.click()
    await expect(page.getByRole('menu')).toHaveAttribute('data-ui-overlay', 'menu')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(menuTrigger).toBeFocused()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
  })

  test('C2 menu submenu, tooltip and localized dialog close share real overlay markers', async () => {
    await page.getByRole('button', { name: '打开真实菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '嵌套菜单', exact: true }).hover()
    await expect(page.getByRole('menu')).toHaveCount(2)
    for (const menu of await page.getByRole('menu').all()) await expect(menu).toHaveAttribute('data-ui-overlay', 'menu')
    const beforeEscape = await page.evaluate(() => ({
      focusedRole: document.activeElement?.getAttribute('role'),
      focusedText: document.activeElement?.textContent,
      menuCount: document.querySelectorAll('[role="menu"]').length
    }))
    const path = test.info().outputPath('submenu-before-escape.json')
    writeFileSync(path, JSON.stringify(beforeEscape, null, 2))
    await test.info().attach('submenu-before-escape', { path, contentType: 'application/json' })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.getByRole('button', { name: '提示入口', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toBeVisible()
    await expect(page.locator('[data-ui-overlay="tooltip"]')).toBeVisible()
    await page.mouse.move(1, 1, { steps: 8 })
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.evaluate(() => window.shadcnProbe.setLanguage('en'))
    await page.getByRole('button', { name: '打开真实 Dialog', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  })

  test('C3 prompt keeps initial selection, trim, empty guard and IME confirmation', async () => {
    await page.evaluate(() => window.shadcnProbe.startPrompt())
    const dialog = page.getByRole('alertdialog', { name: '真实 prompt 合约', exact: true })
    await expect.soft(dialog).toHaveAttribute('data-ui-overlay', 'alert-dialog', { timeout: 1000 })
    const input = page.getByPlaceholder('输入名称')
    await expect(input).toBeFocused()
    expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 4])
    await input.fill('  ')
    await expect(dialog.getByRole('button', { name: '确认名称', exact: true })).toBeDisabled()
    await input.press('Enter')
    await expect(dialog).toBeVisible()
    await input.fill('组合输入')
    await input.dispatchEvent('compositionstart', { data: '组' })
    await input.press('Enter')
    await expect(dialog, 'IME candidate Enter must not resolve a production prompt').toBeVisible()
    expect(await page.evaluate(() => window.shadcnProbe.results)).toEqual([])
    await input.dispatchEvent('compositionend', { data: '组合输入' })
    await input.fill('  确认名称  ')
    await input.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.shadcnProbe.results)).toEqual(['确认名称'])
  })

  test('C3 FIFO confirmation resolves once per request and Escape safely cancels the next', async () => {
    await page.evaluate(() => window.shadcnProbe.enqueue())
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName('FIFO 第一项')
    await page.getByRole('button', { name: '确认第一项', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName('FIFO 第二项')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.shadcnProbe.results))
      .toEqual([
        ['first', true],
        ['second', false]
      ])
    await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
  })

  test('C3 AbortSignal and host unmount settle current and queued requests safely', async () => {
    await page.evaluate(() => window.shadcnProbe.abortable())
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName('可取消的请求')
    await page.evaluate(() => window.shadcnProbe.abort())
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.shadcnProbe.results)).toEqual([['abort', false]])
    await page.evaluate(() => window.shadcnProbe.enqueue())
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName('FIFO 第一项')
    await page.evaluate(() => window.shadcnProbe.unmountHost())
    await expect
      .poll(() => page.evaluate(() => window.shadcnProbe.results))
      .toEqual([
        ['abort', false],
        ['first', false],
        ['second', false]
      ])
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
  })
})
