import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { startSafetyApp, pickSave, pickOpen, ffmpeg, type SafetyApp } from './fixtures/safetyApp'

test.skip(process.env.JIWEI_BACKUP_REAL !== '1', 'JIWEI_BACKUP_REAL=1 强制执行真实素材、模型、网站与 kill -9 验收')
test.setTimeout(1800000)
test.describe.configure({ mode: 'serial' })
const folder = resolve(process.env.SHOTS_DIR ?? `.superpowers/sdd/2026-10-10-backup-and-safety/evidence/real-${Date.now()}`)
const qfl = process.env.JIWEI_REAL_VIDEOS ?? ''
const videos = [
  join(qfl, 'QFL-VIDEO-043/05-审阅候选/QFL-VIDEO-043_审阅候选_v1.mp4'),
  join(qfl, 'QFL-VIDEO-041/05-审阅候选/QFL-VIDEO-041_审阅候选_v1.mp4'),
  join(qfl, 'QFL-VIDEO-045/05-审阅候选/QFL-VIDEO-045_审阅候选_v1.mp4')
]
const pdf = resolve(
  process.env.JIWEI_REAL_PDF ?? '.superpowers/sdd/2026-10-10-mistakes-and-reading/evidence/real/attention-is-all-you-need.pdf'
)
const models = process.env.JIWEI_VOICE_MODELS_APPDATA
let env: SafetyApp, code: string, original: { id: string; sourceId: string }, archive: string, restored: string
function record(row: Record<string, unknown>): void {
  const file = join(folder, 'backup-real.json')
  const records: Record<string, unknown>[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  records.push({ at: new Date().toISOString(), ...row })
  writeFileSync(file, JSON.stringify(records, null, 2))
}
async function browserScript<T>(contentsId: number | undefined, expression: string): Promise<T | null> {
  return env.app.evaluate(
    async ({ webContents }, { contentsId, expression }) => {
      const wc = webContents.fromId(contentsId!)
      if (!wc) return null
      // webContents.executeJavaScript 会等页面停止加载，真实视频站点的子资源可能一直加载。
      // 调试协议读取／操作同一实际 DOM，不替换页面、网络、媒体或应用行为。
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      const result = await Promise.race([
        wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, userGesture: true, timeout: 5000 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000))
      ])
      if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result?.result?.value ?? null
    },
    { contentsId, expression }
  )
}
async function shoot(name: string, contentsId?: number): Promise<void> {
  await env.page.screenshot({ path: join(folder, name + '.png'), animations: 'disabled' })
  await env.app.evaluate(
    async ({ webContents }, { file, contentsId }) => {
      const wc = contentsId ? webContents.fromId(contentsId) : webContents.getAllWebContents().find((w) => /^https?:/.test(w.getURL()))
      if (wc) {
        const capture = await Promise.race([wc.capturePage(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))])
        if (capture) process.getBuiltinModule('fs').writeFileSync(file, capture.toPNG())
      }
    },
    { file: join(folder, name + '-browser.png'), contentsId }
  )
}
async function measured<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  let peakMainKB = 0,
    peakAppKB = 0,
    pending = false
  const sample = async (): Promise<void> => {
    if (pending) return
    pending = true
    try {
      const result = await env.app.evaluate(({ app }) =>
        app.getAppMetrics().map((m) => ({ type: m.type, memory: m.memory.workingSetSize }))
      )
      peakMainKB = Math.max(peakMainKB, result.find((m) => m.type === 'Browser')?.memory ?? 0)
      peakAppKB = Math.max(
        peakAppKB,
        result.reduce((n, m) => n + m.memory, 0)
      )
    } finally {
      pending = false
    }
  }
  await sample()
  const timer = setInterval(() => void sample().catch(() => {}), 50)
  try {
    const result = await fn()
    await sample()
    record({ scenario: name, seconds: (Date.now() - start) / 1000, peakMainMiB: peakMainKB / 1024, peakAppMiB: peakAppKB / 1024 })
    return result
  } finally {
    clearInterval(timer)
  }
}
async function launch(userData?: string, vault?: string): Promise<SafetyApp> {
  return startSafetyApp({ userData, vault, allModels: true, modelsFrom: models })
}
test.beforeAll(async () => {
  mkdirSync(folder, { recursive: true })
  for (const file of [...videos, pdf]) expect(existsSync(file), `必须提供真实素材：${file}`).toBe(true)
  env = await launch()
  record({
    scenario: '运行环境',
    userData: env.userData,
    asr: await env.page.evaluate(() => window.jiwei.asr.status()),
    models: models ?? '本机缓存'
  })
})
test.afterAll(async () => {
  await env?.close().catch(() => {})
})
test.afterEach(async ({ browserName: _browserName }, info) => {
  record({ test: info.title, status: info.status, errors: info.errors.map((e) => e.message) })
  if (info.status !== 'passed') await shoot(`failed-${info.line}`).catch(() => {})
})

async function realRecording(encrypted: boolean): Promise<{ id: string; sourceId: string }> {
  expect((await env.page.evaluate(() => window.jiwei.asr.status())).state).toBe('ready')
  const chunks = join(env.userData, 'real-chunks-' + Date.now())
  mkdirSync(chunks)
  execFileSync(ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-i',
    videos[1],
    '-t',
    '410',
    '-map',
    '0:a:0',
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    '-f',
    'segment',
    '-segment_time',
    '10',
    '-reset_timestamps',
    '1',
    '-y',
    join(chunks, 'part-%03d.webm')
  ])
  const names = readdirSync(chunks)
      .filter((n) => n.endsWith('.webm'))
      .sort()
      .slice(0, 41),
    r = await env.page.evaluate(() =>
      window.jiwei.recording.begin({ scene: 'thought', tracks: ['mic'], localOnly: true, participants: [], extraHotwords: '' })
    )
  expect(names.length).toBeGreaterThanOrEqual(40)
  for (const [sequence, name] of names.entries()) {
    await env.page.evaluate(
      ({ id, sequence, base64 }) =>
        window.jiwei.recording.chunk({
          id,
          track: 'mic',
          sequence,
          startMs: sequence * 10000,
          durationMs: Math.min(10000, 410000 - sequence * 10000),
          bytes: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        }),
      { id: r.id, sequence, base64: readFileSync(join(chunks, name)).toString('base64') }
    )
    if (!sequence) {
      await expect
        .poll(() => env.page.evaluate((id) => window.jiwei.recording.get(id).then((r) => r.preview.length), r.id), { timeout: 90000 })
        .toBeGreaterThan(0)
      record({
        scenario: '真实录音实时字幕',
        encrypted,
        cues: (await env.page.evaluate((id) => window.jiwei.recording.get(id), r.id)).preview
      })
    }
  }
  const complete = await env.page.evaluate((id) => window.jiwei.recording.finish(id), r.id)
  expect(complete.durationMs).toBe(410000)
  expect(complete.encrypted).toBe(encrypted)
  record({ scenario: '真实视频音轨经 begin/chunk 注入', encrypted, durationSeconds: 410, chunks: names.length, recordingId: complete.id })
  return { id: complete.id, sourceId: complete.sourceId! }
}
async function audioDigest(app: SafetyApp, id: string): Promise<string> {
  return app.page.evaluate(async (id) => {
    const digest = await crypto.subtle.digest('SHA-256', await (await fetch(`jiwei://recording/${id}`)).arrayBuffer())
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }, id)
}
async function interruptBackup(mode: 'export' | 'restore', destination: string): Promise<void> {
  await pickSave(env, destination)
  if (mode === 'export') void env.page.evaluate(() => window.jiwei.backups.export()).catch(() => {})
  else {
    await pickOpen(env, archive)
    const preview = await env.page.evaluate(() => window.jiwei.backups.preview())
    void env.page
      .evaluate((token) => window.jiwei.backups.restore({ token, mode: 'new', includeProfile: false, confirmed: false }), preview!.token)
      .catch(() => {})
  }
  await expect
    .poll(
      async () => {
        const s = await env.page.evaluate(() => window.jiwei.backups.status())
        const path = mode === 'export' ? destination + '.partial' : join(destination + '.restoring', 'jiwei.db')
        return (
          s.progress.state === 'running' &&
          s.progress.processed > 1024 * 1024 &&
          s.progress.processed < s.progress.total &&
          existsSync(path) &&
          (mode !== 'export' || s.progress.message.includes('写入备份'))
        )
      },
      { intervals: [1, 2, 5], timeout: 90000 }
    )
    .toBe(true)
  const userData = env.userData
  process.kill(env.app.process().pid!, 'SIGKILL')
  await env.app.close().catch(() => {})
  env = await launch(userData)
  expect(existsSync(destination)).toBe(false)
  expect(existsSync(mode === 'export' ? destination + '.partial' : destination + '.restoring')).toBe(false)
  expect((await env.page.evaluate(() => window.jiwei.recording.list())).some((r) => r.id === original.id)).toBe(true)
  record({ scenario: `${mode} kill -9`, finalPublished: false, stagingCleaned: true })
  await shoot(mode + '-crash-recovered')
}

test('≥500 MB 真实知识库：3 个视频、arXiv PDF、7 分钟录音；加密迁移 kill -9 恢复且逐字节一致', async () => {
  original = await realRecording(false)
  // 素材解析不属于备份验收。先完成录音字幕，避免长视频精修任务占满既有队列。
  for (const job of await env.page.evaluate(() => window.jiwei.jobs.list()))
    if (job.status === 'queued' || job.status === 'running') await env.page.evaluate((id) => window.jiwei.jobs.cancel(id), job.id)
  const second = await realRecording(false)
  for (const job of await env.page.evaluate(() => window.jiwei.jobs.list()))
    if (job.status === 'queued' || job.status === 'running') await env.page.evaluate((id) => window.jiwei.jobs.cancel(id), job.id)
  const imported = await env.page.evaluate((paths) => window.jiwei.sources.importPaths(paths), [...videos, pdf])
  expect(imported.imported.length).toBe(4)
  await env.page.evaluate(async () => {
    await window.jiwei.notes.create({ title: 'v0.6.6 真实知识库备份验收' })
    await window.jiwei.memory.save({
      kind: 'fact',
      key: 'backup-real',
      content: '新 userData 恢复归档时必须恢复个人记忆',
      sensitive: false,
      pinned: true
    })
  })
  const bytes = [...videos, pdf].reduce((n, f) => n + statSync(f).size, 0)
  expect(bytes).toBeGreaterThanOrEqual(500 * 1024 * 1024)
  record({ scenario: '真实知识库种子', bytes, files: [...videos, pdf].map((path) => ({ path, bytes: statSync(path).size })) })
  for (const job of await env.page.evaluate(() => window.jiwei.jobs.list()))
    if (job.status === 'queued' || job.status === 'running') await env.page.evaluate((id) => window.jiwei.jobs.cancel(id), job.id)
  const before = await audioDigest(env, original.sourceId)
  const secondBefore = await audioDigest(env, second.sourceId)
  code = await env.page.evaluate(() => window.jiwei.recording.prepareRecovery())
  await env.page.evaluate((group) => window.jiwei.recording.confirmRecovery(group), code.slice(-4))
  await expect
    .poll(
      async () => {
        const s = await env.page.evaluate(() => window.jiwei.recording.cryptoStatus())
        return s.progress.state === 'running' && s.progress.processed > 0 && s.progress.processed < s.progress.total
      },
      { intervals: [1, 2, 5] }
    )
    .toBe(true)
  const userData = env.userData
  process.kill(env.app.process().pid!, 'SIGKILL')
  await env.app.close().catch(() => {})
  env = await launch(userData)
  await expect
    .poll(() => env.page.evaluate(() => window.jiwei.recording.cryptoStatus().then((s) => s.progress.state)), { timeout: 90000 })
    .toBe('done')
  expect(await audioDigest(env, original.sourceId)).toBe(before)
  expect(await audioDigest(env, second.sourceId)).toBe(secondBefore)
  const list = await env.page.evaluate(() => window.jiwei.recording.list())
  expect(list.length).toBe(2)
  expect(list.every((r) => r.encrypted)).toBe(true)
  record({
    scenario: '加密迁移 kill -9',
    recordings: list.length,
    sha256Before: before,
    sha256After: await audioDigest(env, original.sourceId),
    secondSha256Before: secondBefore,
    secondSha256After: await audioDigest(env, second.sourceId),
    resumed: true
  })
})
test('真实备份、导出与原子恢复：耗时、峰值内存与归档大小', async () => {
  expect(original).toBeTruthy()
  const snapshot = await measured('完整快照', () => env.page.evaluate(() => window.jiwei.backups.create()))
  expect(snapshot.size).toBeGreaterThanOrEqual(500 * 1024 * 1024)
  archive = join(folder, '真实完整备份.jiwei')
  await pickSave(env, archive)
  await measured('ustar 归档导出并校验', () => env.page.evaluate(() => window.jiwei.backups.export()))
  record({ scenario: '归档大小', bytes: statSync(archive).size, knowledgeBytes: snapshot.size })
  await pickOpen(env, archive)
  const preview = await env.page.evaluate(() => window.jiwei.backups.preview())
  restored = join(env.userData, 'real-restored')
  await pickSave(env, restored)
  await measured('恢复为新知识库', () =>
    env.page.evaluate(
      (token) => window.jiwei.backups.restore({ token, mode: 'new', includeProfile: true, confirmed: false }),
      preview!.token
    )
  )
  expect(existsSync(join(restored, 'jiwei.db'))).toBe(true)
  await shoot('large-backup-restored')
})
test('备份与恢复做到一半 kill -9：重启清理且没有发布半截归档／知识库', async () => {
  expect(archive).toBeTruthy()
  await interruptBackup('export', join(folder, 'interrupted.jiwei'))
  await interruptBackup('restore', join(env.userData, 'interrupted-restore'))
})
test('加密后的 7 分钟真实链路：实时字幕→合成→播放拖动→MOSS→CAM++ 复核→删除', async () => {
  if ((await env.page.evaluate(() => window.jiwei.moss.status())).state !== 'ready')
    await env.page.evaluate(() => window.jiwei.moss.install())
  if ((await env.page.evaluate(() => window.jiwei.voiceprint.status())).state !== 'ready')
    await env.page.evaluate(() => window.jiwei.voiceprint.install())
  expect((await env.page.evaluate(() => window.jiwei.voiceprint.status())).state).toBe('ready')
  const r = await measured('加密录音完整链路', () => realRecording(true))
  await expect
    .poll(
      async () => {
        const job = (await env.page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.key === `moss:${r.sourceId}`)
        if (job?.status === 'failed') throw new Error(job.error ?? 'MOSS failed')
        return job?.status
      },
      { timeout: 900000 }
    )
    .toBe('done')
  const segments = await env.page.evaluate((id) => window.jiwei.segments.list(id), r.sourceId),
    speakers = await env.page.evaluate((id) => window.jiwei.recording.speakers(id), r.sourceId)
  expect(segments.some((s) => s.kind === 'transcript')).toBe(true)
  const transcript = segments
    .filter((s) => s.kind === 'transcript')
    .map((s) => s.text)
    .join('\n')
  // 对照真实 QFL041 旁白，而非以任务 done 或非空文本代替内容验收。
  expect(transcript).toContain('参数')
  expect(transcript).toContain('正迁移')
  expect(transcript).toContain('灾难性遗忘')
  record({
    scenario: 'MOSS 真实内容对照',
    reference: join(qfl, 'QFL-VIDEO-041/02-生成素材/旁白/script.json'),
    sourceId: r.sourceId,
    transcript,
    segments
  })
  expect(speakers.length).toBeGreaterThan(0)
  expect(speakers.some((s) => s.hasCentroid)).toBe(true)
  const range = await env.page.evaluate(async (id) => {
    const r = await fetch(`jiwei://recording/${id}`, { headers: { Range: 'bytes=100000-100200' } })
    return { status: r.status, bytes: (await r.arrayBuffer()).byteLength }
  }, r.sourceId)
  expect(range).toEqual({ status: 206, bytes: 201 })
  await env.page.getByRole('button', { name: /资料库/ }).click()
  const source = await env.page.evaluate((id) => window.jiwei.sources.get(id), r.sourceId)
  await env.page.getByText(source!.title, { exact: true }).dblclick()
  await expect
    .poll(() => env.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.readyState), { timeout: 30000 })
    .toBeGreaterThanOrEqual(1)
  await env.page.getByTestId('media').evaluate(async (m: HTMLAudioElement) => {
    m.currentTime = 220
    await m.play()
  })
  await expect.poll(() => env.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.currentTime)).toBeGreaterThan(220)
  await env.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.pause())
  await shoot('encrypted-recording-chain')
  const reviewedLabels = speakers.filter((s) => s.hasCentroid).map((s) => s.label)
  for (const label of reviewedLabels) {
    const speaker = speakers.find((s) => s.label === label)!,
      card = env.page.getByTestId('speaker-card').filter({ hasText: `说话人 ${Number(label.slice(1))} 是谁` })
    await card.getByRole('button', { name: '播放原声', exact: true }).click()
    await expect
      .poll(() => env.page.getByTestId('media').evaluate((m: HTMLAudioElement) => !m.paused && m.currentTime))
      .toBeGreaterThan(speaker.sampleStart)
    await env.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.pause())
    await card.getByRole('button', { name: '确认说话人', exact: true }).click()
    const choices = env.page.getByTestId('speaker-choices'),
      name = `QFL 旁白 ${Number(label.slice(1))}`
    await choices.getByRole('textbox', { name: '新建人员姓名', exact: true }).fill(name)
    await choices.getByRole('button', { name: '添加', exact: true }).click()
    await expect
      .poll(() =>
        env.page.evaluate((name) => window.jiwei.people.list().then((people) => people.find((p) => p.name === name)?.voiceprints), name)
      )
      .toBe(1)
  }
  const confirmed = await env.page.evaluate((id) => window.jiwei.recording.speakers(id), r.sourceId)
  expect(confirmed.filter((s) => reviewedLabels.includes(s.label)).every((s) => s.personId && s.origin === 'user')).toBe(true)
  record({
    scenario: '真实声纹复核',
    sourceId: r.sourceId,
    reviewedLabels,
    speakers: confirmed,
    people: await env.page.evaluate(() => window.jiwei.people.list())
  })
  await shoot('encrypted-speaker-confirmed')
  const confirmedSegments = await env.page.evaluate((id) => window.jiwei.segments.list(id), r.sourceId)
  await env.page.evaluate((id) => window.jiwei.recording.deleteAudio(id), r.id)
  expect(existsSync(join(env.userData, 'data/recordings', r.id))).toBe(false)
  const retained = await env.page.evaluate((id) => window.jiwei.segments.list(id), r.sourceId)
  expect(retained.filter((s) => s.kind === 'transcript')).toEqual(confirmedSegments.filter((s) => s.kind === 'transcript'))
  expect(retained.filter((s) => s.kind === 'transcript').length).toBe(segments.filter((s) => s.kind === 'transcript').length)
  // “删除音频，保留转写稿”不清除已确认身份。彻底删除资料才清除录音关联的 centroid；
  // 已登记到个人库的声纹按原契约保留，需使用独立的“清除声纹”操作删除。
  expect(await env.page.evaluate((id) => window.jiwei.recording.speakers(id), r.sourceId)).toEqual(confirmed)
  const registered = await env.page.evaluate(() => window.jiwei.people.list())
  expect(await env.page.evaluate(async (id) => (await fetch(`jiwei://recording/${id}`)).status, r.sourceId)).toBe(404)
  await env.page.evaluate((id) => window.jiwei.sources.trash(id), r.sourceId)
  await env.page.evaluate((id) => window.jiwei.trash.purge('source', id), r.sourceId)
  expect((await env.page.evaluate(() => window.jiwei.recording.list())).some((item) => item.id === r.id)).toBe(false)
  expect(await env.page.evaluate((id) => window.jiwei.recording.speakers(id), r.sourceId)).toEqual([])
  expect(await env.page.evaluate((id) => window.jiwei.sources.get(id), r.sourceId)).toBeNull()
  expect(await env.page.evaluate(() => window.jiwei.people.list())).toEqual(registered)
  record({
    scenario: '加密录音端到端',
    durationSeconds: 410,
    segments: segments.length,
    speakers: speakers.length,
    voiceCentroids: speakers.filter((s) => s.hasCentroid).length,
    range,
    actualPlayerSeek: 220,
    confirmedSpeakers: reviewedLabels.length,
    transcriptRetainedAfterAudioDeletion: true,
    recordingCentroidsRemovedAfterPurge: true,
    registeredPersonalVoiceprintsRetained: true,
    deleted: true
  })
})
test('全新 userData 恢复的知识库：恢复码解锁、实际播放器拖动与 MOSS 精修', async () => {
  let fresh = await launch()
  try {
    await pickOpen(fresh, archive)
    const preview = await fresh.page.evaluate(() => window.jiwei.backups.preview())
    expect(preview!.profileEmpty).toBe(true)
    const freshVault = join(fresh.userData, 'fresh-restored')
    await pickSave(fresh, freshVault)
    const restoredFresh = await fresh.page.evaluate(
      (token) => window.jiwei.backups.restore({ token, mode: 'new', includeProfile: true, confirmed: false }),
      preview!.token
    )
    expect(restoredFresh!.path).toBe(freshVault)
    expect(
      (await fresh.page.evaluate(() => window.jiwei.memory.list({ search: '新 userData 恢复归档时必须恢复个人记忆' }))).some(
        (m) => m.key === 'backup-real'
      )
    ).toBe(true)
    const freshUserData = fresh.userData
    await fresh.close()
    fresh = await launch(freshUserData, freshVault)
    expect(
      (await fresh.page.evaluate(() => window.jiwei.memory.list({ search: '新 userData 恢复归档时必须恢复个人记忆' }))).some(
        (m) => m.key === 'backup-real'
      )
    ).toBe(true)
    expect((await fresh.page.evaluate(() => window.jiwei.recording.cryptoStatus())).unlocked).toBe(false)
    expect(await fresh.page.evaluate(async (id) => (await fetch(`jiwei://recording/${id}`)).status, original.sourceId)).toBe(423)
    await fresh.page.evaluate((code) => window.jiwei.recording.unlock(code), code)
    await fresh.page.getByRole('button', { name: /资料库/ }).click()
    const source = await fresh.page.evaluate((id) => window.jiwei.sources.get(id), original.sourceId)
    await fresh.page.getByText(source!.title, { exact: true }).dblclick()
    await expect
      .poll(() => fresh.page.getByTestId('media').evaluate((media: HTMLAudioElement) => media.readyState), { timeout: 30000 })
      .toBeGreaterThanOrEqual(1)
    await fresh.page.getByTestId('media').evaluate(async (media: HTMLAudioElement) => {
      media.currentTime = 220
      await media.play()
    })
    await expect.poll(() => fresh.page.getByTestId('media').evaluate((media: HTMLAudioElement) => media.currentTime)).toBeGreaterThan(220)
    await fresh.page.getByTestId('media').evaluate((media: HTMLAudioElement) => media.pause())
    const jobs = await fresh.page.evaluate(() => window.jiwei.jobs.list())
    for (const j of jobs.filter((j) => j.key === `moss:${original.sourceId}` && !['done', 'canceled'].includes(j.status)))
      await fresh.page.evaluate((id) => window.jiwei.jobs.cancel(id), j.id)
    await fresh.page.evaluate((id) => window.jiwei.moss.refine(id, true), original.sourceId)
    await expect
      .poll(
        async () => {
          const job = (await fresh.page.evaluate(() => window.jiwei.jobs.list())).filter((j) => j.key === `moss:${original.sourceId}`)[0]
          if (job?.status === 'failed') throw new Error(job.error ?? 'MOSS failed')
          return job?.status
        },
        { timeout: 900000 }
      )
      .toBe('done')
    const freshSegments = await fresh.page.evaluate((id) => window.jiwei.segments.list(id), original.sourceId),
      freshTranscript = freshSegments
        .filter((s) => s.kind === 'transcript')
        .map((s) => s.text)
        .join('\n')
    expect(freshTranscript).toContain('参数')
    expect(freshTranscript).toContain('正迁移')
    expect(freshTranscript).toContain('灾难性遗忘')
    record({ scenario: '新 userData MOSS 内容对照', sourceId: original.sourceId, transcript: freshTranscript, segments: freshSegments })
    record({ scenario: '另一台电脑模拟', freshUserData: fresh.userData, recoveredPlayback: true, seekSeconds: 220, mossDone: true })
    await fresh.page.screenshot({ path: join(folder, 'fresh-device-player.png') })
  } finally {
    await fresh.close()
  }
})
test('真实 Google／YouTube 登录引导与系统打开、系统代理开启时 bilibili 直连播放', async () => {
  test.setTimeout(360000)
  await env.app.evaluate(({ session }) => {
    Object.assign(globalThis, { backupBrowserErrors: [] as unknown[] })
    session.fromPartition('persist:jiwei-browser').webRequest.onErrorOccurred((details) => {
      if (!/^https?:/.test(details.url)) return
      const url = new URL(details.url)
      ;(globalThis as typeof globalThis & { backupBrowserErrors: unknown[] }).backupBrowserErrors.push({
        host: url.hostname,
        path: url.pathname,
        type: details.resourceType,
        error: details.error
      })
    })
  })
  await env.page.keyboard.press('ControlOrMeta+n')
  await env.page.getByPlaceholder('笔记标题').fill('真实浏览器验收')
  await env.page.keyboard.press('Enter')
  await env.page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  await env.page.evaluate(() => window.jiwei.browser.open('https://www.google.com/', { newTab: true }))
  const id = await env.page.evaluate(() => window.jiwei.browser.state().then((s) => s.activeId!))
  await expect
    .poll(() => env.page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)?.loading), id), {
      timeout: 60000
    })
    .toBe(false)
  await env.page.evaluate((id) => window.jiwei.browser.navigate(id, 'https://accounts.google.com/ServiceLogin'), id)
  await expect(env.page.getByTestId('browser-login-warning')).toBeVisible({ timeout: 60000 })
  await shoot('google-login-warning')
  await env.page.getByRole('button', { name: '在系统浏览器中打开', exact: true }).click()
  record({ scenario: 'Google 实际登录页', hint: true, systemBrowserInvoked: true })
  const beforeYoutube = await env.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.id))
  const youtube = await env.page.evaluate(() => window.jiwei.browser.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { newTab: true }))
  const youtubeContentsId = await env.app.evaluate(
    ({ webContents }, before) => webContents.getAllWebContents().find((w) => !before.includes(w.id))?.id,
    beforeYoutube
  )
  expect(youtubeContentsId, '实际新增的 YouTube 网页视图').toBeTruthy()
  // 实站广告等子资源可能持续加载；等待实际登录入口或机器人引导，而非全部网络停止。
  try {
    await expect
      .poll(
        () =>
          browserScript<boolean>(
            youtubeContentsId,
            `/^https:\\/\\/(www\\.)?youtube\\.com\\//.test(location.href) && (!![...document.querySelectorAll('a')].find(a => /accounts.google.com/.test(a.href) && /Sign in|登录/.test(a.innerText)) || /Sign in to confirm you're not a bot|登录以确认你不是机器人/.test(document.body?.innerText ?? ''))`
          ),
        { timeout: 90000 }
      )
      .toBe(true)
  } finally {
    record({
      scenario: 'YouTube 页面诊断',
      page: await browserScript(
        youtubeContentsId,
        `({url:location.origin+location.pathname,title:document.title,readyState:document.readyState,body:document.body?.innerText.slice(0,2000),signInLinks:[...document.querySelectorAll('a')].filter(a => /Sign in|登录/.test(a.innerText)).map(a => ({text:a.innerText,host:a.href.startsWith('http')?new URL(a.href).hostname:a.href.split(':')[0]})),initialDataKeys:Object.keys(window.ytInitialData??{}),ytcfg:typeof window.ytcfg,scripts:[...document.scripts].filter(s=>s.src).map(s=>({host:new URL(s.src).hostname,path:new URL(s.src).pathname})),videos:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,ready:v.readyState,paused:v.paused}))})`
      ),
      networkErrors: await env.app.evaluate(
        () => (globalThis as typeof globalThis & { backupBrowserErrors: unknown[] }).backupBrowserErrors
      )
    })
    await shoot('youtube-load-result', youtubeContentsId)
  }
  await shoot('youtube-live', youtubeContentsId)
  let state = await env.page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)), youtube)
  const botPageObserved = state?.loginBlocked?.reason === 'youtube'
  if (!state?.loginBlocked) {
    // 实站不一定要求机器人验证；在正常页面走真实“登录”入口，仍需出现嵌入式登录引导。
    const clicked = await browserScript<boolean>(
      youtubeContentsId,
      `(() => { const a=[...document.querySelectorAll('a')].find(a => /accounts.google.com/.test(a.href) && /Sign in|登录/.test(a.innerText)); if(!a)return false; a.click(); return true })()`
    )
    expect(clicked, 'YouTube 的实际登录入口').toBe(true)
    await expect(env.page.getByTestId('browser-login-warning')).toBeVisible({ timeout: 60000 })
    state = await env.page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)), youtube)
  }
  expect(state?.loginBlocked, 'YouTube 实际登录流程的引导').toBeTruthy()
  await shoot('youtube-login-warning', youtubeContentsId)
  record({ scenario: 'YouTube 实际登录流程', botPageObserved, hint: state!.loginBlocked!.reason, loginUrl: state!.url })
  await env.page.evaluate((id) => window.jiwei.browser.openExternal(id), youtube)
  expect((await env.page.evaluate(() => window.jiwei.browser.networkStatus())).proxyAvailable).toBe(true)
  const systemProxy = await env.app.evaluate(({ session }) =>
    session.fromPartition('jiwei-system-proxy').resolveProxy('https://en.wikipedia.org/')
  )
  expect(systemProxy).toContain('127.0.0.1:1082')
  await env.page.evaluate(() =>
    window.jiwei.browser.networkRules(['bilibili.com', 'bilivideo.com', 'hdslb.com'].map((domain) => ({ domain, mode: 'direct' })))
  )
  expect(
    await env.app.evaluate(({ session }) => session.fromPartition('persist:jiwei-browser').resolveProxy('https://www.bilibili.com/'))
  ).toBe('DIRECT')
  const existingIds = await env.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.id))
  await env.page.evaluate(() => window.jiwei.browser.open('https://www.bilibili.com/video/BV1GJ411x7h7/', { newTab: true }))
  const biliContentsId = await env.app.evaluate(
    ({ webContents }, before) => webContents.getAllWebContents().find((w) => !before.includes(w.id))?.id,
    existingIds
  )
  expect(biliContentsId, '实际新增的 B站网页视图').toBeTruthy()
  try {
    await expect
      .poll(
        () =>
          browserScript<boolean>(
            biliContentsId,
            '(() => {const v=document.querySelector("video");if(v){v.muted=true;v.play().catch(()=>{});}return !!v && !v.paused && v.readyState>=3 && v.currentTime>3})()'
          ),
        { timeout: 90000 }
      )
      .toBe(true)
  } finally {
    const diagnostic = await env.app.evaluate(async ({ webContents }, id) => {
      const wc = webContents.fromId(id!)
      return {
        url: wc?.getURL(),
        loading: wc?.isLoading(),
        errors: (globalThis as typeof globalThis & { backupBrowserErrors: unknown[] }).backupBrowserErrors
      }
    }, biliContentsId)
    record({
      scenario: 'bilibili 播放诊断',
      diagnostic,
      page: await browserScript(
        biliContentsId,
        `({ title:document.title, body:document.body?.innerText.slice(0,2000), videos:[...document.querySelectorAll('video')].map(v => ({ host: v.currentSrc.startsWith('http') ? new URL(v.currentSrc).hostname : v.currentSrc.split(':')[0], time:v.currentTime, ready:v.readyState, duration:v.duration, error:v.error?.message, paused:v.paused })) })`
      ),
      browser: await env.page.evaluate(() => window.jiwei.browser.state())
    })
    await shoot('bilibili-playback-result', biliContentsId)
  }
  await shoot('bilibili-direct-playback', biliContentsId)
  record({
    scenario: 'YouTube／bilibili 实站',
    youtubeHint: true,
    youtubeBotPageObserved: botPageObserved,
    systemProxy,
    bilibiliDirectPlayback: true
  })
})
