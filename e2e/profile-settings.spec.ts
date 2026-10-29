import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fields = [
  { key: 'role', name: '我是', limit: 500 },
  { key: 'goals', name: '方向', limit: 6000 },
  { key: 'background', name: '已有基础', limit: 1000 },
  { key: 'style', name: '回答偏好', limit: 6000 },
  { key: 'avoid', name: '请避免', limit: 1000 }
] as const

const launch = (userData: string, language = 'zh-CN'): Promise<ElectronApplication> =>
  electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: language, JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })

async function openProfile(app: ElectronApplication, language = 'zh-CN'): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.keyboard.press('Meta+,')
  await page
    .getByRole('dialog')
    .getByRole('tab', { name: language === 'zh-CN' ? '关于我' : 'About me', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: language === 'zh-CN' ? '我是' : 'I am', exact: true })).toBeVisible()
  return page
}

test('profile settings count all fields and persist 6000-character directions and answer style across restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-profile-capacity-'))
  let app = await launch(userData)
  const goals = '方向\n'.padEnd(5991, '方') + 'GOALS_END'
  const style = '偏好😀\n'.padEnd(5991, '偏') + 'STYLE_END'
  try {
    const page = await openProfile(app)
    for (const field of fields)
      await expect(page.getByRole('textbox', { name: field.name, exact: true }).locator('..')).toContainText(
        `已用 0 / 最多 ${field.limit} 字符`
      )
    for (const [name, text] of [
      ['方向', goals],
      ['回答偏好', style]
    ] as const) {
      const field = page.getByRole('textbox', { name, exact: true })
      await field.focus()
      await page.keyboard.insertText(text)
      await expect(field.locator('..')).toContainText('已用 6000 / 最多 6000 字符')
      await expect(field.locator('..').getByRole('status')).toHaveText('已保存')
    }
    expect(await page.evaluate(() => window.jiwei.memory.profile())).toMatchObject({ goals, style })
    await page.screenshot({ path: test.info().outputPath('profile-counts.png') })
    await app.close()
    app = await launch(userData)
    const reopened = await openProfile(app)
    await expect(reopened.getByRole('textbox', { name: '方向', exact: true })).toHaveValue(goals)
    await expect(reopened.getByRole('textbox', { name: '回答偏好', exact: true })).toHaveValue(style)
  } finally {
    await app.close()
  }
})

test('profile settings show specific overflow errors, preserve saved data and recover for every field', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), 'jiwei-profile-overflow-')))
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await page.evaluate(() =>
      window.jiwei.memory.setProfile({ role: '原值', goals: '原值', background: '原值', style: '原值', avoid: '原值' })
    )
    await openProfile(app)
    for (const { key, name, limit } of fields) {
      const field = page.getByRole('textbox', { name, exact: true })
      await expect(field).toHaveValue('原值')
      const overflow = '文'.repeat(limit + 1)
      await expect(
        page.evaluate(({ key, overflow }) => window.jiwei.memory.setProfile({ [key]: overflow }), { key, overflow })
      ).rejects.toThrow('Too big')
      await field.fill(overflow)
      await expect(field.locator('..')).toContainText(`已用 ${limit + 1} / 最多 ${limit} 字符`)
      await expect(field).toHaveAttribute('aria-invalid', 'true')
      await expect(field.locator('..').getByRole('alert')).toContainText('超出字符限制')
      await field.blur()
      await expect(
        page
          .locator('[data-sonner-toast]')
          .filter({ hasText: `最多 ${limit} 字符，当前 ${limit + 1} 字符` })
          .first()
      ).toBeVisible()
      await expect(field.locator('..').getByRole('status')).toHaveText('未保存')
      expect((await page.evaluate(() => window.jiwei.memory.profile()))[key]).toBe('原值')
      await expect(field).toHaveValue(overflow)
      if (key === 'goals') await page.screenshot({ path: test.info().outputPath('profile-overflow.png') })
      await field.fill('原值')
      await expect(field.locator('..').getByRole('status')).toHaveText('已保存')
      await expect(field.locator('..').getByRole('alert')).toHaveCount(0)
      const valid = '文'.repeat(limit)
      await field.fill(valid)
      await expect(field.locator('..').getByRole('status')).toHaveText('已保存')
      await expect(field).not.toHaveAttribute('aria-invalid', 'true')
      expect((await page.evaluate(() => window.jiwei.memory.profile()))[key]).toBe(valid)
    }
  } finally {
    await app.close()
  }
})

test('profile settings localize counters and overflow errors in English', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), 'jiwei-profile-en-')), 'en')
  try {
    const page = await openProfile(app, 'en')
    const field = page.getByRole('textbox', { name: 'Directions', exact: true })
    await expect(field.locator('..')).toContainText('0 / 6000 characters used')
    await field.fill('x'.repeat(6001))
    await expect(field.locator('..').getByRole('alert')).toContainText('Character limit exceeded')
    await field.blur()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Character limit exceeded' }).first()).toBeVisible()
    await expect(field.locator('..').getByRole('status')).toHaveText('Not saved')
  } finally {
    await app.close()
  }
})
