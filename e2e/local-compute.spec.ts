import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchScannedPdfApp } from './fixtures/scannedPdfApp'

async function openComputeSettings(page: Page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await page.getByRole('button', { name: 'AI 模型', exact: true }).click()
  const section = page.getByTestId('local-compute-settings')
  await expect(section).toBeVisible()
  await section.scrollIntoViewIfNeeded()
  return section
}

test('actual settings UI persists only-CPU and redetect preserves it across app restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jiwei-compute-settings-'))
  let { app, page } = await launchScannedPdfApp(directory)
  try {
    let section = await openComputeSettings(page)
    await section.getByRole('combobox', { name: '计算设备', exact: true }).selectOption('cpu')
    await expect.poll(() => page.evaluate(() => window.jiwei.settings.get().then((s) => s.ai.localCompute))).toBe('cpu')
    const modelRoot = join(directory, 'model-appdata', 'jiwei-models')
    mkdirSync(modelRoot, { recursive: true })
    writeFileSync(
      join(modelRoot, 'accel.json'),
      JSON.stringify({
        version: 1,
        health: { 'b11491:metal:embedding': { reason: 'controlled previous GPU failure', at: Date.now() } },
        benchmarks: {},
        devices: [],
        cuda: { build: 'b11491', failures: 0, disabled: true, preferVulkan: false, reason: null }
      })
    )
    await section.getByRole('button', { name: '重新检测', exact: true }).click()
    await expect.poll(() => Object.keys(JSON.parse(readFileSync(join(modelRoot, 'accel.json'), 'utf8')).health).length).toBe(0)
    expect(JSON.parse(readFileSync(join(modelRoot, 'accel.json'), 'utf8')).cuda.disabled).toBe(true)
    await expect.poll(() => page.evaluate(() => window.jiwei.localCompute.status().then((s) => s.maintenance))).toBeNull()
    expect(await page.evaluate(() => window.jiwei.settings.get().then((s) => s.ai.localCompute))).toBe('cpu')
    await app.close()
    ;({ app, page } = await launchScannedPdfApp(directory))
    section = await openComputeSettings(page)
    await expect(section.getByRole('combobox', { name: '计算设备', exact: true })).toHaveValue('cpu')
    await expect(section.getByTestId('local-compute-embedding')).toContainText('空闲')
    const evidence = process.env.JIWEI_COMPUTE_EVIDENCE
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      await page.screenshot({ path: join(evidence, 'settings-persistence.png') })
    }
  } finally {
    await app.close()
  }
})
