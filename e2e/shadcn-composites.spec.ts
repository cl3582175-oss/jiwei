import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedElectron } from './fixtures/isolateElectron'
import { navTo } from './fixtures/nav'

async function moveRight(page: Page, from: Locator, to: Locator, state: 'aria-checked' | 'aria-selected'): Promise<void> {
  await from.focus()
  await page.keyboard.down('ArrowRight')
  try {
    await expect(to).toBeFocused()
    await expect(to).toHaveAttribute(state, 'true')
  } finally {
    await page.keyboard.up('ArrowRight')
  }
}

test('non-AI inbox tabs retain keyboard navigation after preserving released AI controls', async () => {
  let app: ElectronApplication | undefined
  try {
    app = await isolatedElectron.launch({
      args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-composites-'))}`],
      env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
    })
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    // AI works/review retain their released v0.14.21 controls per revised scope.
    await navTo(page, /收件箱/)
    const inbox = page.getByTestId('inbox-view')
    await moveRight(page, inbox.getByRole('tab', { name: '待整理', exact: true }), inbox.getByRole('tab', { name: '精选', exact: true }), 'aria-selected')
    await expect(inbox.getByRole('tabpanel', { name: '精选', exact: true })).toBeVisible()
    await expect(inbox.getByRole('tabpanel', { name: '待整理', exact: true })).toHaveCount(0)
  } finally {
    await app?.close()
  }
})
