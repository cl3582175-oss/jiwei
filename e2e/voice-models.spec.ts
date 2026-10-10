import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, existsSync, symlinkSync, writeFileSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

test.skip(process.env.JIWEI_MOSS !== '1', 'JIWEI_MOSS=1 运行真实 MOSS + CAM++，不以离线分段代替')
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const fixture = resolve('e2e/fixtures/meeting.wav')
const turns = JSON.parse(readFileSync(resolve('e2e/fixtures/meeting.json'), 'utf8')) as {
  turns: { voice: string; start: number; end: number }[]
}
const root = process.env.JIWEI_VOICE_MODELS_APPDATA
  ? resolve(process.env.JIWEI_VOICE_MODELS_APPDATA)
  : mkdtempSync(join(tmpdir(), 'jiwei-voice-models-'))
const cache = join(homedir(), 'Library/Application Support/jiwei-models')
mkdirSync(join(root, 'jiwei-models'), { recursive: true })
for (const name of ['ffmpeg', 'sherpa-onnx-1.13.8', 'moss', 'asr'])
  if (existsSync(join(cache, name)) && !existsSync(join(root, 'jiwei-models', name)))
    symlinkSync(join(cache, name), join(root, 'jiwei-models', name), 'dir')
test.beforeAll(async () => {
  test.setTimeout(1200000)
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-voice-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ app }, root) => app.setPath('appData', root), root)
  await page.evaluate(() => window.jiwei.moss.install())
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.jiwei.moss.status())
        if (s.state === 'error') throw new Error(s.message!)
        return s.state
      },
      { timeout: 1000000, intervals: [1000, 2000] }
    )
    .toBe('ready')
  await page.evaluate(() => window.jiwei.voiceprint.install())
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.jiwei.voiceprint.status())
        if (s.state === 'error') throw new Error(s.message!)
        return s.state
      },
      { timeout: 120000, intervals: [1000, 2000] }
    )
    .toBe('ready')
})
test.afterAll(async () => {
  await app?.close()
})
async function refine(): Promise<string> {
  const input = join(root, 'fixture.webm')
  execFileSync(join(root, 'jiwei-models/ffmpeg/ffmpeg'), ['-nostdin', '-v', 'error', '-i', fixture, '-c:a', 'libopus', '-y', input])
  const r = await page.evaluate(() =>
    window.jiwei.recording.begin({ scene: 'meeting', tracks: ['mic'], participants: [], extraHotwords: '积微,FSRS', localOnly: true })
  )
  await page.evaluate(
    ({ id, bytes }) =>
      window.jiwei.recording.chunk({ id, track: 'mic', sequence: 0, startMs: 0, durationMs: 45000, bytes: new Uint8Array(bytes) }),
    { id: r.id, bytes: [...readFileSync(input)] }
  )
  const done = await page.evaluate((id) => window.jiwei.recording.finish(id), r.id)
  const id = done.sourceId!
  await page.evaluate((id) => window.jiwei.sources.update(id, { title: '积微 FSRS 三人会议' }), id)
  await expect
    .poll(
      async () => {
        const job = (await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.key === `moss:${id}`)
        if (job?.status === 'failed') throw new Error(job.error ?? 'MOSS failed')
        return job?.status
      },
      { timeout: 600000, intervals: [1000, 2000] }
    )
    .toBe('done')
  return id
}
let sourceId = ''
test('真实精修包含关键句、三人、积微与 FSRS，同一合成声音各段一致', async () => {
  test.setTimeout(600000)
  sourceId = await refine()
  const segments = await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)
  if (process.env.SHOTS_DIR) writeFileSync(join(process.env.SHOTS_DIR, 'moss-live-transcript.json'), JSON.stringify(segments, null, 2))
  const text = segments.map((s) => s.text).join('\n')
  expect(text).toContain('积微')
  expect(text).toContain('FSRS')
  expect(text).toContain('间隔重复')
  expect(text).toMatch(/确认任务/)
  expect(new Set(segments.map((s) => s.locator.speaker)).size).toBe(3)
  const voices = new Map<string, Set<unknown>>()
  for (const turn of turns.turns) {
    const mids = segments.filter((s) => {
      const tm = /^t=([\d.]+),([\d.]+)$/.exec(String(s.locator.value))
      const mid = tm ? (Number(tm[1]) + Number(tm[2])) / 2 : -1
      return mid >= turn.start && mid <= turn.end + 0.5
    })
    expect(mids.length).toBeGreaterThan(0)
    const labels = voices.get(turn.voice) ?? new Set<unknown>()
    mids.forEach((s) => labels.add(s.locator.speaker))
    voices.set(turn.voice, labels)
  }
  for (const labels of voices.values()) expect(labels.size).toBe(1)
  expect(new Set([...voices.values()].map((labels) => [...labels][0])).size).toBe(3)
})
test('确认三人后再次精修自动认出，并保留已登记的声纹数量', async () => {
  test.setTimeout(600000)
  const speakers = await page.evaluate((id) => window.jiwei.recording.speakers(id), sourceId)
  for (const [i, s] of speakers.entries()) {
    const p = await page.evaluate(({ i }) => window.jiwei.people.save({ name: `会议成员 ${i + 1}`, isMe: i === 0 }), { i })
    await page.evaluate(({ id, label, personId }) => window.jiwei.recording.confirm({ sourceId: id, label, personId }), {
      id: sourceId,
      label: s.label,
      personId: p.id
    })
  }
  const before = await page.evaluate(() => window.jiwei.people.list())
  await page.evaluate((id) => window.jiwei.moss.refine(id), sourceId)
  await expect
    .poll(
      async () => {
        const jobs = (await page.evaluate(() => window.jiwei.jobs.list())).filter((j) => j.key === `moss:${sourceId}`)
        if (jobs.some((j) => j.status === 'failed')) throw new Error(jobs.find((j) => j.status === 'failed')!.error!)
        return jobs.filter((j) => j.status === 'done').length
      },
      { timeout: 600000, intervals: [1000, 2000] }
    )
    .toBe(2)
  const after = await page.evaluate((id) => window.jiwei.recording.speakers(id), sourceId)
  expect(after).toHaveLength(3)
  expect(after.every((s) => s.personId && s.origin === 'auto')).toBe(true)
  expect((await page.evaluate(() => window.jiwei.people.list())).map((p) => p.voiceprints)).toEqual(before.map((p) => p.voiceprints))
  await page.getByRole('button', { name: /资料库/ }).click()
  await page.getByText('积微 FSRS 三人会议', { exact: true }).dblclick()
  await expect(page.getByTestId('dialogue-transcript')).toBeVisible()
  await expect(page.getByTestId('speaker-card')).toHaveCount(0)
})

test('精修进入声纹阶段时清除，迟到结果只发布文字且不恢复中心', async () => {
  test.setTimeout(600000)
  // 在 MOSS 输出完成的进度事件上清除，覆盖 CAM++ 提取/校验期间的竞态。
  await page.evaluate(async (id) => {
    let cleared = false
    const pending = new Promise<void>((resolve, reject) => {
      const stop = window.jiweiEvents.on('jobs:changed', () => {
        void window.jiwei.jobs
          .list()
          .then(async (jobs) => {
            const job = jobs.find((j) => j.key === `moss:${id}` && j.status === 'running')
            if (cleared || !job || job.progress < 0.95) return
            cleared = true
            stop()
            try {
              await window.jiwei.people.clear(false)
              resolve()
            } catch (error) {
              reject(error)
            }
          })
          .catch(reject)
      })
    })
    await window.jiwei.moss.refine(id)
    await pending
  }, sourceId)
  await expect
    .poll(
      async () => {
        const jobs = (await page.evaluate(() => window.jiwei.jobs.list())).filter((j) => j.key === `moss:${sourceId}`)
        if (jobs.some((j) => j.status === 'failed')) throw new Error(jobs.find((j) => j.status === 'failed')!.error!)
        return jobs.filter((j) => j.status === 'done').length
      },
      { timeout: 600000, intervals: [500, 1000] }
    )
    .toBe(3)
  const transcript = await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)
  expect(transcript.map((s) => s.text).join('')).toContain('FSRS')
  expect((await page.evaluate(() => window.jiwei.people.list())).every((p) => p.voiceprints === 0)).toBe(true)
  expect((await page.evaluate((id) => window.jiwei.recording.speakers(id), sourceId)).every((s) => !s.hasCentroid)).toBe(true)
})
