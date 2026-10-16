import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchScannedPdfApp } from './fixtures/scannedPdfApp'
import { navTo } from './fixtures/nav'
import { makeCcittMaskPdf } from '../src/worker/__tests__/fixtures/maskPdf'

async function openProjectPdf(app: ElectronApplication, page: Page, path: string) {
  const project = await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, recognition: { mode: 'off', providerId: null, model: null, auto: false, figures: true, localModel: 'fast' } }
    })
    return window.jiwei.chatProjects.create({ name: 'PDF 预览验证', memory: 'project', libraryScope: 'none' })
  })
  await navTo(page, /积微助手/)
  const sidebar = page.getByTestId('sidebar-chat')
  await expect(sidebar).toBeVisible()
  if ((await sidebar.getAttribute('data-collapsed')) === 'true') await sidebar.getByTestId('sidebar-spine').click()
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
  await sidebar.locator(`[data-project-id="${project.id}"] [data-sidebar-row]`).first().click()
  await page.getByTestId('project-home').getByRole('tab', { name: '来源', exact: true }).click()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path)
  const panel = page.getByRole('tabpanel', { name: '来源', exact: true })
  await panel.getByRole('button', { name: '添加来源', exact: true }).first().click()
  await page.getByTestId('add-project-sources').getByRole('button', { name: '上传', exact: true }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.chatProjects.sources(id).then((s) => s.length), project.id)).toBe(1)
  const [source] = await page.evaluate((id) => window.jiwei.chatProjects.sources(id), project.id)
  await panel.locator(`[data-project-source-id="${source.itemId}"] button`).first().click()
  await expect(page.getByTestId('pdf-viewer')).toBeVisible()
}

async function pixels(page: Page, n: number) {
  const element = page.getByTestId('pdf-viewer').locator(`.page[data-page-number="${n}"]`)
  await expect(element).toHaveCount(1)
  await element.scrollIntoViewIfNeeded()
  const snapshot = () =>
    element.evaluate((el) => {
      const c = el.querySelector('canvas')
      if (!c || c.hidden || !c.width || !c.height) return { dark: 0, total: 0 }
      const p = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
      let dark = 0
      for (let i = 0; i < p.length; i += 4) if (p[i + 3] && Math.min(p[i], p[i + 1], p[i + 2]) < 180) dark++
      return { dark, total: c.width * c.height }
    })
  await expect.poll(async () => (await snapshot()).dark, { timeout: 15000 }).toBeGreaterThan(1000)
  return snapshot()
}

test('project preview renders a CCITT mask as visible black and white pixels without OCR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-preview-ccitt-'))
  const file = join(dir, 'CCITT.pdf')
  writeFileSync(file, makeCcittMaskPdf())
  const { app, page } = await launchScannedPdfApp(dir)
  // CI desktops can constrain the window below the sidebar's automatic collapse threshold.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760))
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await openProjectPdf(app, page, file)
    const actual = await pixels(page, 1)
    expect(actual.dark / actual.total).toBeGreaterThan(0.4)
    expect(actual.dark / actual.total).toBeLessThan(0.6)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('original project preview shows the cover and scan pages 5, 10, 320 and 640 without OCR', async () => {
  test.skip(!process.env.JIWEI_SCAN_REAL_PDF, 'Requires explicitly supplied original PDF')
  test.setTimeout(90000)
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-preview-original-'))
  const { app, page } = await launchScannedPdfApp(dir)
  const errors: string[] = [],
    warnings: string[] = [],
    results = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text())
  })
  try {
    await openProjectPdf(app, page, process.env.JIWEI_SCAN_REAL_PDF!)
    await expect(page.getByTestId('pdf-viewer').locator('.page')).toHaveCount(640)
    for (const n of [1, 5, 10, 320, 640]) {
      const actual = await pixels(page, n)
      if (n >= 5) expect(actual.dark / actual.total).toBeLessThan(0.85)
      results.push({ page: n, ...actual })
    }
    expect(errors).toEqual([])
    expect(warnings.filter((s) => /failed to initialize|ignoring XObject|wasmUrl.*provided/.test(s))).toEqual([])
    if (process.env.JIWEI_SCAN_EVIDENCE) {
      mkdirSync(process.env.JIWEI_SCAN_EVIDENCE, { recursive: true })
      await page.screenshot({ path: join(process.env.JIWEI_SCAN_EVIDENCE, 'original-preview-after.png') })
      writeFileSync(
        join(process.env.JIWEI_SCAN_EVIDENCE, 'original-preview-after.json'),
        JSON.stringify({ original: process.env.JIWEI_SCAN_REAL_PDF, pages: 640, results, errors, warnings }, null, 2)
      )
    }
  } finally {
    await app.close()
  }
})
