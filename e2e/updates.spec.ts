import { test, expect } from '@playwright/test'
import { mkdirSync, readdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { updateFixture } from './fixtures/updateApp'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

const shots = '.superpowers/sdd/v0.11-update-sign-import/evidence/P3/shots'

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform} automatic check announces available updates outside settings and supports later`, async () => {
    const env = await updateFixture({ platform, delay: 500 })
    try {
      await expect(env.page.getByTestId('update-available-notice')).toContainText('发现新版本 1.0.0')
      await env.page.getByTestId('update-available-notice').getByRole('button', { name: '查看更新', exact: true }).click()
      await expect(env.page.getByTestId('update-settings')).toContainText('发现新版本 1.0.0')
      await env.page.keyboard.press('Escape')
      await env.page.getByTestId('update-available-notice').getByRole('button', { name: '稍后', exact: true }).click()
      await expect(env.page.getByTestId('update-available-notice')).toHaveCount(0)
      expect(env.requests.some((path) => /\.(dmg|exe)$/.test(path))).toBe(false)
    } finally {
      await env.close()
    }
  })
}

test('macOS manual: real feed check, progress, verified dmg and replacement guide', async () => {
  const env = await updateFixture()
  try {
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('button', { name: '关于', exact: true }).click({ timeout: 5000 })
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('发现新版本 1.0.0')
    await expect(env.page.getByTestId('update-notes')).toContainText('原创更新说明')
    expect(await env.page.locator('script[data-update-injection]').count()).toBe(0)
    expect(env.requests.some((p) => p.includes('tracking.png'))).toBe(false)
    await env.page.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(env.page.getByRole('progressbar')).toBeVisible()
    await expect(env.page.getByTestId('update-replace-guide')).toBeVisible()
    expect(readdirSync(env.downloads).filter((n) => n.endsWith('.dmg'))).toHaveLength(1)
    mkdirSync(shots, { recursive: true })
    await env.page.screenshot({ path: join(shots, 'update-mac-light.png') })
    await env.page.evaluate(() => window.jiwei.settings.set({ theme: 'dark', language: 'en' }))
    await env.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setMinimumSize(640, 600)
      win.setSize(760, 760)
    })
    await expect(env.page.getByTestId('update-settings')).toContainText('Open the installer and quit Jiwei')
    expect(await env.page.getByTestId('update-settings').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false)
    await env.page.screenshot({ path: join(shots, 'update-mac-dark-narrow-en.png') })
    await env.page.getByRole('button', { name: 'Open the installer and quit Jiwei', exact: true }).click()
    await expect(env.page.locator('nav').first()).toBeVisible() // Explicit dev gate prevents quitting or running fixture installers.
  } finally {
    await env.close()
  }
})

test('Windows automatic branch downloads through real electron-updater and offers restart', async () => {
  const env = await updateFixture({ platform: 'win32' })
  try {
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('button', { name: '关于', exact: true }).click({ timeout: 5000 })
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByRole('button', { name: '重新启动以更新', exact: true })).toBeVisible()
    await env.page.keyboard.press('Escape')
    await expect(env.page.getByTestId('update-restart-notice')).toContainText('1.0.0')
    await expect(env.page.getByRole('button', { name: '现在重启', exact: true })).toBeVisible()
    expect(env.requests.some((p) => p.endsWith('.exe'))).toBe(true)
    await env.page.getByRole('button', { name: '稍后', exact: true }).click({ timeout: 5000 })
    await expect(env.page.getByTestId('update-restart-notice')).toHaveCount(0)
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('button', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '重新启动以更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toBeVisible()
  } finally {
    await env.close()
  }
})

test('checksum mismatch removes the unverified dmg and presents an inline retry', async () => {
  const env = await updateFixture({ corrupt: true })
  try {
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('button', { name: '关于', exact: true }).click({ timeout: 5000 })
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByRole('button', { name: '下载更新', exact: true })).toBeVisible()
    await env.page.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('校验失败')
    expect(readdirSync(env.downloads).filter((n) => n.endsWith('.dmg') || n.endsWith('.part'))).toHaveLength(0)
    await expect(env.page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
    env.metadata.corrupt = false
    await env.page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(env.page.getByTestId('update-replace-guide')).toBeVisible()
  } finally {
    await env.close()
  }
})

test('disabled automatic checks stay disabled across settings changes', async () => {
  const env = await updateFixture({ delay: 1200 })
  try {
    await env.page.evaluate(() => window.jiwei.settings.set({ updates: { autoCheck: false } }))
    const before = env.requests.length
    await env.page.evaluate(() => window.jiwei.settings.set({ theme: 'dark' }))
    await env.page.waitForTimeout(1600)
    expect(env.requests.length).toBe(before)
  } finally {
    await env.close()
  }
})

test('manual download uses the release selected by the user even when the feed advances', async () => {
  const env = await updateFixture()
  try {
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('button', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByRole('button', { name: '下载更新', exact: true })).toBeVisible()
    env.metadata.version = '1.1.0'
    await env.page.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(env.page.getByTestId('update-replace-guide')).toBeVisible()
    expect(env.requests.some((url) => url.includes('Jiwei-1.0.0-mac-') && url.endsWith('.dmg'))).toBe(true)
    expect(env.requests.some((url) => url.includes('Jiwei-1.1.0-mac-') && url.endsWith('.dmg'))).toBe(false)
  } finally {
    await env.close()
  }
})

test('a read-only download folder produces a recoverable storage error', async () => {
  const env = await updateFixture()
  try {
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('button', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByRole('button', { name: '下载更新', exact: true })).toBeVisible()
    chmodSync(env.downloads, 0o500)
    await env.page.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('无法保存安装包')
    chmodSync(env.downloads, 0o700)
    await env.page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(env.page.getByTestId('update-replace-guide')).toBeVisible()
  } finally {
    chmodSync(env.downloads, 0o700)
    await env.close()
  }
})

test('an upgraded vault is snapshotted before its version record changes and retains two snapshots', async () => {
  let env = await updateFixture()
  const userData = env.userData
  try {
    for (let i = 1; i <= 3; i++) {
      await env.app.evaluate(({ app }, from) => {
        const path = process.getBuiltinModule('path'),
          load = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'))
        const Database = load('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(path.join(app.getPath('userData'), 'data', 'jiwei.db'))
        try {
          db.prepare("UPDATE meta SET value=? WHERE key='app.runVersion'").run(from)
        } finally {
          db.close()
        }
      }, `0.8.${i}`)
      await env.close()
      env = await updateFixture({ userData })
      const state = await env.page.evaluate(() => window.jiwei.updates.status())
      expect(state.upgrade?.from).toBe(`0.8.${i}`)
      expect(state.upgrade?.backupFailed).not.toBe(true)
      const snapshot = state.upgrade!.backupName!
      const contents = await env.app.evaluate(({ app }, name) => {
        const path = process.getBuiltinModule('path'),
          load = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'))
        const Database = load('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(path.join(app.getPath('userData'), 'data', 'backups', 'updates', name), { readonly: true })
        try {
          return (db.prepare("SELECT value FROM meta WHERE key='app.runVersion'").get() as { value: string }).value
        } finally {
          db.close()
        }
      }, snapshot)
      expect(contents).toBe(`0.8.${i}`)
    }
    expect(readdirSync(join(userData, 'data', 'backups', 'updates')).filter((n) => n.endsWith('.db'))).toHaveLength(2)
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('button', { name: '关于', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText(`已更新到 ${version}`)
    await env.page.getByRole('button', { name: '关闭升级提示', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).not.toContainText(`已更新到 ${version}`)
  } finally {
    await env.close()
  }
})
