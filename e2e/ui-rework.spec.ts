import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isolatedElectron } from './fixtures/isolateElectron'


let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  app = await isolatedElectron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-ui-rework-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('today-view')).toBeVisible()
})

test.afterEach(async () => { await app?.close() })

async function borderless(control: Locator): Promise<void> {
  await expect(control).toBeVisible()
  await control.click()
  await expect(control).toBeFocused()
  const pointer = await control.evaluate((node) => {
    const style = getComputedStyle(node)
    return { border: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor], outline: style.outlineStyle, shadow: style.boxShadow }
  })
  expect(pointer.border.every((color) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent')).toBe(true)
  expect(pointer.outline).toBe('none')
  expect(pointer.shadow).toBe('none')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(control).toBeFocused()
  const keyboard = await control.evaluate((node) => {
    const style = getComputedStyle(node)
    return { border: style.borderTopColor, outline: style.outlineStyle, shadow: style.boxShadow }
  })
  expect(keyboard.border).toBe('rgba(0, 0, 0, 0)')
  expect(keyboard.outline).toBe('none')
  expect(keyboard.shadow).toBe('none')
}

test('text fields and released AI composer have no frame or focus ring in every palette and theme', async () => {
  test.setTimeout(120_000)
  for (const palette of ['qinglu', 'celadon', 'dunhuang'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => window.jiwei.settings.set(value), { palette, theme })
      await expect(page.locator('html')).toHaveAttribute('data-palette', palette)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.keyboard.press('ControlOrMeta+,')
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('tab', { name: '通用', exact: true }).click()
      await borderless(dialog.getByRole('textbox', { name: '你的名字', exact: true }))
      await dialog.getByRole('tab', { name: '关于我', exact: true }).click()
      await borderless(dialog.locator('textarea').first())
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await page.keyboard.press('ControlOrMeta+3')
      const input = page.getByRole('textbox', { name: '问积微，或交代一件事……', exact: true })
      await borderless(input)
      const group = input.locator('xpath=..')
      await expect(group).toHaveAttribute('data-slot', 'input-group')
      const style = await group.evaluate((node) => {
        const s = getComputedStyle(node)
        return { border: s.borderTopColor, outline: s.outlineStyle, shadow: s.boxShadow, direction: s.flexDirection }
      })
      expect(style).toEqual({ border: 'rgba(0, 0, 0, 0)', outline: 'none', shadow: 'none', direction: 'column' })
      const addon = group.locator('[data-slot="input-group-addon"]')
      const tools = group.locator('[data-slot="input-group-tools"]')
      const send = group.getByRole('button', { name: '发送', exact: true })
      await expect(addon).toHaveCount(1)
      await expect(tools).toHaveCount(1)
      const [inputBox, addonBox, toolsBox, sendBox] = await Promise.all([input.boundingBox(), addon.boundingBox(), tools.boundingBox(), send.boundingBox()])
      expect(inputBox && addonBox && toolsBox && sendBox).toBeTruthy()
      expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(addonBox!.y + 1)
      expect(sendBox!.x).toBeGreaterThanOrEqual(toolsBox!.x + toolsBox!.width - 1)
      expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(addonBox!.y + addonBox!.height + 1)
    }
  }
})

test('About Me keeps four sections in one horizontal row in both languages and at the minimum window size', async () => {
  test.setTimeout(90_000)
  for (const language of ['zh-CN', 'en'] as const) {
    for (const [width, height] of [[1440, 900], [1000, 640]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
      await page.evaluate(async (language) => {
        await window.jiwei.settings.set({ language })
      }, language)
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      await page.keyboard.press('ControlOrMeta+,')
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('tab', { name: language === 'zh-CN' ? '关于我' : 'About me', exact: true }).click()
      const row = dialog.locator('[role="tablist"][aria-orientation="horizontal"]')
      const tabs = row.getByRole('tab')
      await expect(tabs).toHaveCount(4)
      if (language === 'zh-CN') expect(await tabs.allTextContents()).toEqual(['档案', '记忆', '学习情况', '学习经历'])
      const boxes = await tabs.evaluateAll((items) => items.map((item) => {
        const r = item.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }))
      expect(Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y))).toBeLessThanOrEqual(1)
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 1)
      for (let index = 0; index < 4; index++) {
        await tabs.nth(index).click()
        await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true')
        await expect(row.locator('[aria-selected="true"]')).toHaveCount(1)
      }
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }
  }
})



test('borderless CSS contract covers every native text-entry type and overrides caller focus decoration without changing size', async () => {
  await page.evaluate(() => {
    const fixture = document.createElement('section')
    fixture.dataset.testid = 'rework-input-contract'
    fixture.style.cssText = 'position:fixed;inset:80px 100px;overflow:auto;background:var(--surface);padding:20px;z-index:100'
    const style = document.createElement('style')
    style.textContent = '.rework-framed { border:2px solid rgb(0,150,80); outline:3px solid rgb(0,150,80); box-shadow:0 0 0 4px rgb(0,150,80); width:180px; height:38px } .rework-framed:focus { outline-width:5px; box-shadow:0 0 0 6px rgb(0,150,80) }'
    fixture.append(style)
    for (const type of ['text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'file']) {
      const input = document.createElement('input')
      input.type = type
      input.className = 'rework-framed'
      input.dataset.kind = type
      fixture.append(input)
    }
    const textarea = document.createElement('textarea')
    textarea.dataset.kind = 'textarea'
    textarea.className = 'rework-framed'
    fixture.append(textarea)
    const select = document.createElement('select')
    select.dataset.kind = 'select'
    select.className = 'rework-framed'
    select.add(new Option('真实原生选项', 'one'))
    fixture.append(select)
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    editable.dataset.kind = 'contenteditable'
    editable.className = 'rework-framed'
    fixture.append(editable)
    const group = document.createElement('div')
    group.dataset.slot = 'input-group'
    group.dataset.kind = 'group'
    group.className = 'rework-framed'
    const input = document.createElement('input')
    group.append(input)
    fixture.append(group)
    document.body.append(fixture)
  })
  try {
    const controls = page.getByTestId('rework-input-contract').locator('[data-kind]')
    await expect(controls).toHaveCount(17)
    for (const control of await controls.all()) {
      const before = await control.boundingBox()
      const target = await control.getAttribute('data-kind') === 'group' ? control.locator('input') : control
      await target.focus()
      const result = await control.evaluate((node) => {
        const s = getComputedStyle(node)
        return { colors: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor], borderWidth: s.borderTopWidth, outline: s.outlineStyle, shadow: s.boxShadow }
      })
      expect(result.colors).toEqual(Array(4).fill('rgba(0, 0, 0, 0)'))
      expect(result.borderWidth).toBe('2px')
      expect(result.outline).toBe('none')
      expect(result.shadow).toBe('none')
      const after = await control.boundingBox()
      expect(after?.width).toBe(before?.width)
      expect(after?.height).toBe(before?.height)
    }
  } finally {
    await page.getByTestId('rework-input-contract').evaluate((node) => node.remove())
  }
})
