import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 数学动画插件（v0.10）：
//   常规：插件能力说明、运行环境面板、没装环境时笔记动画显示静态公式、讲解视频的动画场景退回普通场景并提示原因。
//   JIWEI_TEST_MANIM=1：真实下载运行环境（约 170 MB，装好约 0.9 GB，测完随临时目录删除），笔记动画与视频片段真的生成。
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const real = process.env.JIWEI_TEST_MANIM === '1'
const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-manim-'))
let workId = ''

const derivation = {
  kind: 'derivation',
  steps: [
    { tex: 'x^2+2x+1', note: '观察系数' },
    { tex: '(x+1)^2', note: '完全平方' }
  ]
}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async (derivation) => {
    const api = window.jiwei.plugins
    const op = await api.beginAcquisition()
    const r = await api.acquire(op, { kind: 'market', market: 'jiwei', name: 'manim' })
    if (r.kind !== 'plugin') throw new Error('expected plugin')
    await api.confirmInstall(r.preview.token, { feeds: [], config: {} })
    await api.cancelAcquisition(op)
    const n = await window.jiwei.notes.create({ title: '完全平方动画' })
    await window.jiwei.proposals.create({
      noteId: n.id,
      title: '数学动画',
      ops: [{ op: 'insert_row', afterRowId: null, cue: [], body: [{ type: 'embed', attrs: { id: 'a', kind: 'animation' } }] }],
      embeds: { a: { kind: 'animation', data: { title: '完全平方公式', animation: derivation } } }
    } as never)
  }, derivation)
  await page.reload()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

test('plugin explains the runtime it needs; runtime panel offers the download', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('tab', { name: '插件', exact: true }).click()
  await page.getByRole('radiogroup', { name: '插件', exact: true }).getByRole('radio', { name: '已安装', exact: true }).click()
  const row = page.locator('[data-plugin-id="manim@jiwei"]')
  await expect(row).toContainText('数学动画（Manim）')
  await expect(row).toContainText('下载运行环境')
  await row.getByRole('button', { name: '管理', exact: true }).click()
  const details = page.getByTestId('plugin-details')
  await expect(details).toContainText('在沙箱里运行，禁止联网')
  await expect(details).not.toContainText('只包含文字内容')
  const runtime = details.getByTestId('manim-runtime')
  await expect(runtime).toContainText(/首次下载约 \d+ MB/)
  await expect(runtime.getByRole('button', { name: '下载运行环境' })).toBeVisible()
  // 插件自带的模板脚本是积微运行的，不标成“只读取、不会运行”
  await expect(details).not.toContainText('含脚本')
  await page.getByTestId('plugin-details').getByRole('button', { name: '关闭', exact: true }).last().click()
  await page.keyboard.press('Escape')
})

test('without the runtime a note animation shows the static steps and where to get it', async () => {
  test.skip(real)
  await navTo(page, /^笔记/)
  await page.locator('[data-note-id]').filter({ hasText: '完全平方动画' }).first().click()
  await page.getByRole('button', { name: '全部接受' }).click()
  const block = page.locator('.embed-block[data-kind="animation"]')
  await expect(block.getByTestId('animation-embed')).toContainText('完全平方公式')
  await expect(block.locator('.katex')).toHaveCount(2)
  await expect(block).toContainText('观察系数')
  await expect(block.getByRole('button', { name: /下载数学动画的运行环境/ })).toBeVisible()
})

test('a video animation scene falls back to a regular scene and says why', async () => {
  test.skip(real)
  test.setTimeout(240_000)
  workId = await page.evaluate(async (derivation) => {
    const w = await window.jiwei.works.create({ type: 'video', title: '完全平方', topic: '完全平方', mode: 'cowrite' })
    await window.jiwei.works.update({
      id: w.id,
      content: {
        kind: 'video',
        voice: { engine: 'none', providerId: null, voice: null },
        parts: [
          { id: 's1', template: 'title', title: '完全平方', subtitle: '', narration: '我们来看完全平方公式。', sources: [] },
          { id: 's2', template: 'animation', title: '推导', narration: '把它写成平方的形式。', sources: [], animation: derivation },
          { id: 's3', template: 'summary', title: '小结', items: ['看系数'], narration: '记住这个规律。', sources: [] }
        ]
      }
    } as never)
    await window.jiwei.works.render(w.id)
    return w.id
  }, derivation)
  const st = await page.evaluate((id) => window.jiwei.works.renderStatus(id), workId)
  expect(st.status).toBe('done')
  expect(st.message).toContain('换成了普通场景')
})

test('real runtime: install, note animation plays, video embeds the clip', async () => {
  test.skip(!real, 'JIWEI_TEST_MANIM=1 才真实下载运行环境')
  test.setTimeout(20 * 60_000)
  await page.evaluate(() => window.jiwei.manim.install({ useSystemTex: true }))
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.manim.status())).state, { timeout: 15 * 60_000, intervals: [3000] })
    .toBe('ready')
  await navTo(page, /^笔记/)
  await page.locator('[data-note-id]').filter({ hasText: '完全平方动画' }).first().click()
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect(page.locator('.embed-block[data-kind="animation"] video')).toHaveAttribute(
    'src',
    /^jiwei:\/\/animations\/[0-9a-f]{32}\.webm$/,
    {
      timeout: 120_000
    }
  )
  if (process.env.SHOTS_DIR) {
    await page.waitForTimeout(2500)
    await page.locator('.embed-block[data-kind="animation"]').screenshot({ path: join(process.env.SHOTS_DIR, 'manim-note.png') })
  }
  const st = await page.evaluate(async (derivation) => {
    const w = await window.jiwei.works.create({ type: 'video', title: '完全平方', topic: '完全平方', mode: 'cowrite' })
    await window.jiwei.works.update({
      id: w.id,
      content: {
        kind: 'video',
        voice: { engine: 'none', providerId: null, voice: null },
        parts: [
          { id: 's1', template: 'title', title: '完全平方', subtitle: '', narration: '我们来看完全平方公式。', sources: [] },
          { id: 's2', template: 'animation', title: '推导', narration: '把它写成平方的形式。', sources: [], animation: derivation }
        ]
      }
    } as never)
    await window.jiwei.works.render(w.id)
    return window.jiwei.works.renderStatus(w.id)
  }, derivation)
  expect(st.status).toBe('done')
  expect(st.message).toBeNull()
  // 抽一帧动画场景（第二个场景中段）留给审查看
  const ff = join(process.env.HOME ?? '', 'Library/Application Support/jiwei-models/ffmpeg/ffmpeg')
  if (process.env.SHOTS_DIR && st.file && existsSync(ff)) {
    const { spawnSync } = await import('child_process')
    spawnSync(ff, [
      '-v',
      'error',
      '-y',
      '-sseof',
      '-1.2',
      '-i',
      st.file,
      '-frames:v',
      '1',
      join(process.env.SHOTS_DIR, 'manim-video-frame.png')
    ])
  }
  const freed = await page.evaluate(() => window.jiwei.manim.remove())
  expect(freed).toBeGreaterThan(300e6)
  expect((await page.evaluate(() => window.jiwei.manim.status())).state).toBe('missing')
})
