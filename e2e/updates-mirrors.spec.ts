import { test, expect } from '@playwright/test'
import { updateMirrorFixture } from './fixtures/updateMirrorApp'

test('About falls back to a mirror when the default GitHub check fails before discovering a version', async () => {
  const env = await updateMirrorFixture()
  try {
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('tab', { name: '关于', exact: true }).click()
    expect((await env.page.evaluate(() => window.jiwei.settings.get())).updates?.feedUrl).toBe('')
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('发现新版本 1.0.0')
    await expect(env.page.getByTestId('update-notes')).toContainText('镜像更新说明')
    const requests = await env.networkRequests()
    expect(requests.some((url) => new URL(url).hostname === 'github.com')).toBe(true)
    expect(requests.some((url) => url.startsWith('https://gh-proxy.com/https://github.com/') && url.includes('latest-mac.yml'))).toBe(true)
    expect(env.control.requests.some((url) => /\.(dmg|zip|exe)/.test(url))).toBe(false)
  } finally {
    await env.close()
  }
})

test('About uses the second mirror if the first mirror fails', async () => {
  const env = await updateMirrorFixture()
  try {
    env.control.firstMirror = false
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('tab', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('发现新版本 1.0.0')
    expect((await env.networkRequests()).some((url) => url.startsWith('https://ghfast.top/'))).toBe(true)
    expect(env.control.requests.some((url) => /\.(dmg|zip|exe)/.test(url))).toBe(false)
  } finally {
    await env.close()
  }
})

test('About aborts a hanging GitHub request before falling back to a mirror', async () => {
  const env = await updateMirrorFixture()
  try {
    env.control.hangPrimary = true
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('tab', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('发现新版本 1.0.0', { timeout: 15_000 })
    expect(env.control.abortedPrimary).toBeGreaterThan(0)
  } finally {
    await env.close()
  }
})

test('changing to a custom source cancels a hanging default check without starting mirrors', async () => {
  const env = await updateMirrorFixture()
  try {
    env.control.hangPrimary = true
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('tab', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect.poll(() => env.control.requests.some((url) => url.startsWith('/github/'))).toBe(true)
    await env.page.evaluate(() =>
      window.jiwei.settings.set({ updates: { feedUrl: 'https://custom-update.test/stable/', autoCheck: false } })
    )
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('发现新版本 1.0.0')
    expect(env.control.abortedPrimary).toBeGreaterThan(0)
    expect((await env.networkRequests()).some((url) => /gh-proxy\.com|ghfast\.top/.test(new URL(url).hostname))).toBe(false)
  } finally {
    await env.close()
  }
})

test('About can report the current version through a mirror', async () => {
  const env = await updateMirrorFixture()
  try {
    env.control.response = 'current'
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('tab', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('已是最新版本')
  } finally {
    await env.close()
  }
})

test('About keeps GitHub when it is reachable', async () => {
  const env = await updateMirrorFixture()
  try {
    env.control.primary = true
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('tab', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('发现新版本 1.0.0')
    expect((await env.networkRequests()).some((url) => /gh-proxy\.com|ghfast\.top/.test(new URL(url).hostname))).toBe(false)
  } finally {
    await env.close()
  }
})

test('About shows failure when every source fails and recovers on a new check', async () => {
  const env = await updateMirrorFixture()
  try {
    env.control.response = 'unavailable'
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('tab', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByRole('alert')).toContainText('无法连接更新服务器')
    await expect(env.page.getByTestId('update-settings')).not.toContainText('已是最新版本')
    env.control.response = 'available'
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByTestId('update-settings')).toContainText('发现新版本 1.0.0')
  } finally {
    await env.close()
  }
})

test('custom feed settings persist and bypass default mirror fallback even on failure', async () => {
  let env = await updateMirrorFixture()
  try {
    await env.page.evaluate(() =>
      window.jiwei.settings.set({ updates: { feedUrl: 'https://custom-update.test/stable/', autoCheck: false } })
    )
    const userData = env.userData
    await env.close()
    env = await updateMirrorFixture({ userData })
    env.control.response = 'unavailable'
    await env.page.getByRole('button', { name: /^设置/ }).click()
    await env.page.getByRole('tab', { name: '关于', exact: true }).click()
    await env.page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(env.page.getByRole('alert')).toBeVisible()
    const settings = await env.page.evaluate(() => window.jiwei.settings.get())
    expect(settings.updates?.feedUrl).toBe('https://custom-update.test/stable/')
    expect(settings.updates?.autoCheck).toBe(false)
    const requests = await env.networkRequests()
    expect(requests.some((url) => new URL(url).hostname === 'custom-update.test')).toBe(true)
    expect(requests.some((url) => /github\.com|gh-proxy\.com|ghfast\.top/.test(new URL(url).hostname))).toBe(false)
  } finally {
    await env.close()
  }
})
