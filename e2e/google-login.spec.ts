import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// 借系统 Chrome 登录 Google：用 Chrome 替身（只实现 DevTools 的 Storage.getCookies）验证
// 拉起 → 等登录 → 搬运 cookie → 关闭并删除临时目录；取消；退出登录。真实 Google 由人工验收。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const work = mkdtempSync(join(tmpdir(), 'jiwei-e2e-glogin-'))
const userData = join(work, 'user')
const loginFile = join(work, 'logged-in')
const logFile = join(work, 'chrome.log')
writeFileSync(logFile, '')

const launches = (): { profile: string; pid: number }[] =>
  readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const info = () => page.evaluate(() => window.jiwei.browser.googleLoginStatus())
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_TEST_CHROME_PATH: resolve('e2e/fixtures/fakeChrome.cjs'),
      FAKE_CHROME_LOGIN_FILE: loginFile,
      FAKE_CHROME_LOG: logFile
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(work, { recursive: true, force: true })
})

test('登录后搬运 Google / YouTube cookie，关闭 Chrome 并删除临时目录', async () => {
  expect((await info()).loggedIn).toBe(false)
  await page.evaluate(() => window.jiwei.browser.googleLoginStart())
  await expect.poll(() => launches().length).toBe(1)
  const { profile, pid } = launches()[0]
  expect(realpathSync(profile + '/..')).toBe(realpathSync(userData))
  expect((await info()).state.status).toBe('waiting')
  // 没登录时不搬运
  await new Promise((r) => setTimeout(r, 2500))
  expect((await info()).loggedIn).toBe(false)

  writeFileSync(loginFile, '1')
  await expect.poll(async () => (await info()).state.status, { timeout: 30_000 }).toBe('done')
  expect((await info()).loggedIn).toBe(true)
  const names = await app.evaluate(async ({ session }) => {
    const all = await session.fromPartition('persist:jiwei-browser').cookies.get({})
    return all.map((c) => `${c.domain}|${c.name}`).sort()
  })
  expect(names).toContain('.google.com|SID')
  expect(names).toContain('.youtube.com|LOGIN_INFO')
  expect(names.some((n) => n.includes('example.com'))).toBe(false)
  // 临时目录和 Chrome 进程都清理了
  await expect.poll(() => existsSync(profile)).toBe(false)
  await expect.poll(() => alive(pid)).toBe(false)
  expect(readdirSync(userData).some((n) => n.startsWith('google-login-'))).toBe(false)
})

test('退出 Google 登录只清 Google / YouTube 的 cookie', async () => {
  await page.evaluate(() => window.jiwei.browser.googleLogout())
  expect((await info()).loggedIn).toBe(false)
  const names = await app.evaluate(async ({ session }) =>
    (await session.fromPartition('persist:jiwei-browser').cookies.get({})).map((c) => c.name)
  )
  expect(names).not.toContain('SID')
  expect(names).not.toContain('LOGIN_INFO')
})

test('取消登录：关闭 Chrome、删除临时目录、不搬运任何 cookie', async () => {
  rmSync(loginFile, { force: true })
  await page.evaluate(() => window.jiwei.browser.googleLoginStart())
  await expect.poll(() => launches().length).toBe(2)
  const { profile, pid } = launches()[1]
  await page.evaluate(() => window.jiwei.browser.googleLoginCancel())
  await expect.poll(async () => (await info()).state.reason, { timeout: 15_000 }).toBe('cancelled')
  await expect.poll(() => existsSync(profile)).toBe(false)
  await expect.poll(() => alive(pid)).toBe(false)
  expect((await info()).loggedIn).toBe(false)
})
