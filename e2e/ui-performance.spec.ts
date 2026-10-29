import { test, expect, type Page } from '@playwright/test'
import { isolatedElectron } from './fixtures/isolateElectron'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

type Interaction = 'settings-ready' | 'command-input-ready' | 'note-menu-ready' | 'page-today-ready' | 'page-note-ready'
interface Metric {
  samplesMs: number[]
  p50Ms: number
  p95Ms: number
  minMs: number
  maxMs: number
}
interface PerformanceReport {
  schemaVersion: 1
  collectedAt: string
  method: string
  warmup: number
  samples: number
  environment: Record<string, unknown>
  dataset: { title: string; notes: number; providers: number }
  metrics: Record<Interaction, Metric>
}

const WARMUP = 20
const SAMPLES = 50
const TITLE = 'shadcn 本地交互性能基线'
const QUERY = '本地基线'
const interactions: Interaction[] = ['settings-ready', 'command-input-ready', 'note-menu-ready', 'page-today-ready', 'page-note-ready']

// Start at the actual input event inside the renderer. Readiness is the first observed
// animation frame with the real target state, so Playwright polling/IPC latency is not timed.
async function arm(page: Page, kind: Interaction): Promise<void> {
  await page.evaluate(
    ({ kind, query }) => {
      const state = window as typeof window & { shadcnPerformance?: Promise<number> }
      state.shadcnPerformance = new Promise<number>((resolve, reject) => {
        const key = kind === 'settings-ready' ? ',' : kind === 'command-input-ready' ? 'k' : kind === 'page-today-ready' ? '9' : '1'
        const eventName = kind === 'note-menu-ready' ? 'pointerdown' : 'keydown'
        const visible = (element: Element | null): element is HTMLElement =>
          element instanceof HTMLElement && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
        const ready = (): boolean => {
          if (kind === 'settings-ready')
            return Array.from(document.querySelectorAll('[role="dialog"]')).some(
              (dialog) => visible(dialog) && dialog.querySelectorAll('nav button, [role="tab"]').length >= 16
            )
          if (kind === 'command-input-ready') {
            const input = document.querySelector<HTMLInputElement>('[cmdk-input]')
            return visible(input) && input.value === query && document.activeElement === input
          }
          if (kind === 'note-menu-ready')
            return Array.from(document.querySelectorAll('[role="menu"]')).some(
              (menu) => visible(menu) && menu.querySelectorAll('[role="menuitem"]').length >= 3
            )
          if (kind === 'page-today-ready') return visible(document.querySelector('[data-testid="today-view"]'))
          return visible(document.querySelector('[placeholder="笔记标题"]'))
        }
        const start = (event: Event): void => {
          if (event instanceof KeyboardEvent && event.key.toLowerCase() !== key) return
          document.removeEventListener(eventName, start, true)
          const at = performance.now()
          const frame = (): void => {
            if (ready()) resolve(performance.now() - at)
            else if (performance.now() - at > 10_000) reject(new Error(`${kind}: real UI did not become ready`))
            else requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        }
        document.addEventListener(eventName, start, true)
      })
    },
    { kind, query: QUERY }
  )
}

async function measured(page: Page, kind: Interaction, action: () => Promise<unknown>): Promise<number> {
  await arm(page, kind)
  await action()
  return page.evaluate(() => (window as typeof window & { shadcnPerformance: Promise<number> }).shadcnPerformance)
}

function summarize(samplesMs: number[]): Metric {
  const sorted = [...samplesMs].sort((a, b) => a - b)
  return {
    samplesMs,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1]
  }
}

test('SC-005 real local controls: 20 warmups and 50 measured samples per interaction', async () => {
  test.setTimeout(180_000)
  const profile = mkdtempSync(join(tmpdir(), 'jiwei-shadcn-performance-'))
  const app = await isolatedElectron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${profile}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('today-view')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await page.evaluate(() => window.jiwei.settings.set({ theme: 'light', palette: 'qinglu', language: 'zh-CN' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.keyboard.press('ControlOrMeta+1')
    await page.keyboard.press('ControlOrMeta+n')
    await page.getByPlaceholder('笔记标题').fill(TITLE)
    await page.getByPlaceholder('笔记标题').blur()
    await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({}).then((notes) => notes.map((n) => n.title)))).toEqual([TITLE])
    await expect(page.locator('.cornell-body').first()).toBeVisible()
    const samples = Object.fromEntries(interactions.map((name) => [name, [] as number[]])) as Record<Interaction, number[]>
    const round = async (record: boolean): Promise<void> => {
      const add = (name: Interaction, ms: number): void => {
        if (record) samples[name].push(ms)
      }
      add('settings-ready', await measured(page, 'settings-ready', () => page.keyboard.press('ControlOrMeta+,')))
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      add(
        'command-input-ready',
        await measured(page, 'command-input-ready', async () => {
          await page.keyboard.press('ControlOrMeta+k')
          await page.locator('[cmdk-input]').fill(QUERY)
        })
      )
      await expect(page.locator('[cmdk-input]')).toHaveValue(QUERY)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      add(
        'note-menu-ready',
        await measured(page, 'note-menu-ready', () =>
          page.locator('main header').getByRole('button', { name: '更多', exact: true }).click()
        )
      )
      await expect(page.getByRole('menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      add('page-today-ready', await measured(page, 'page-today-ready', () => page.keyboard.press('ControlOrMeta+9')))
      await expect(page.getByTestId('today-view')).toBeVisible()
      add('page-note-ready', await measured(page, 'page-note-ready', () => page.keyboard.press('ControlOrMeta+1')))
      await expect(page.getByPlaceholder('笔记标题')).toHaveValue(TITLE)
    }
    for (let index = 0; index < WARMUP; index++) await round(false)
    for (let index = 0; index < SAMPLES; index++) await round(true)
    const report: PerformanceReport = {
      schemaVersion: 1,
      collectedAt: new Date().toISOString(),
      method:
        'Renderer input event capture to first requestAnimationFrame with real ready state. Command includes text entry. Nearest-rank P50/P95; local real IPC; no provider calls or sleeps.',
      warmup: WARMUP,
      samples: SAMPLES,
      environment: {
        platform: platform(),
        osRelease: release(),
        cpu: cpus()[0]?.model,
        viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })),
        electron: await app.evaluate(() => process.versions.electron),
        sourceRoot: process.cwd(),
        mainBundleSha256: createHash('sha256')
          .update(readFileSync(resolve('out/main/index.js')))
          .digest('hex'),
        profile
      },
      dataset: { title: TITLE, notes: 1, providers: (await page.evaluate(() => window.jiwei.providers.list())).length },
      metrics: Object.fromEntries(interactions.map((kind) => [kind, summarize(samples[kind])])) as Record<Interaction, Metric>
    }
    const output = process.env.JIWEI_UI_PERFORMANCE_OUTPUT || test.info().outputPath('ui-performance.json')
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    await test.info().attach('ui-performance', { path: output, contentType: 'application/json' })
    if (process.env.JIWEI_UI_PERFORMANCE_BASELINE) {
      const before = JSON.parse(readFileSync(process.env.JIWEI_UI_PERFORMANCE_BASELINE, 'utf8')) as PerformanceReport
      expect(before.warmup).toBe(WARMUP)
      expect(before.samples).toBe(SAMPLES)
      expect(before.dataset).toEqual(report.dataset)
      expect(before.environment.viewport).toEqual(report.environment.viewport)
      for (const kind of interactions)
        expect(report.metrics[kind].p95Ms, `${kind} P95 exceeds the same-machine baseline by >10%`).toBeLessThanOrEqual(
          before.metrics[kind].p95Ms * 1.1
        )
    }
  } finally {
    await app.close()
  }
})
