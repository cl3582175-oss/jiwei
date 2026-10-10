import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

let app: ElectronApplication, page: Page
const data = mkdtempSync(join(tmpdir(), 'jiwei-voice-life-'))
const modelRoot = mkdtempSync(join(tmpdir(), 'jiwei-voice-life-models-'))
const models = join(modelRoot, 'jiwei-models')
mkdirSync(models)
const cache = join(homedir(), 'Library/Application Support/jiwei-models')
for (const name of ['ffmpeg', 'asr', 'sherpa-onnx-1.13.8'])
  if (existsSync(join(cache, name))) symlinkSync(join(cache, name), join(models, name), 'dir')
const voice = process.env.JIWEI_VOICE_MODELS_APPDATA && resolve(process.env.JIWEI_VOICE_MODELS_APPDATA, 'jiwei-models/voiceprint')
if (voice && existsSync(voice)) symlinkSync(voice, join(models, 'voiceprint'), 'dir')

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${data}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ app }, root) => app.setPath('appData', root), modelRoot)
}
test.beforeAll(launch)
test.afterAll(async () => {
  await app?.close()
})

test('人员只进入个人数据库，不进入知识库文件', async () => {
  const person = await page.evaluate(() => window.jiwei.people.save({ name: '个人声纹边界', isMe: true }))
  const storage = await app.evaluate(({ app }, id) => {
    const path = process.getBuiltinModule('path'),
      fs = process.getBuiltinModule('fs')
    const req = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'))
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const library = new Database(path.join(app.getPath('userData'), 'data/jiwei.db'), { readonly: true })
    const profilePath = path.join(app.getPath('userData'), 'profile/memory.db')
    let profileHasPerson = false
    try {
      if (fs.existsSync(profilePath)) {
        const profile = new Database(profilePath, { readonly: true })
        try {
          if (profile.prepare("SELECT 1 FROM sqlite_master WHERE name='people'").get())
            profileHasPerson = !!profile.prepare('SELECT 1 FROM people WHERE id=?').get(id)
        } finally {
          profile.close()
        }
      }
      return {
        profileHasPerson,
        libraryPrivateTables: library
          .prepare("SELECT name FROM sqlite_master WHERE name IN ('people','voiceprints','recording_speakers')")
          .all()
      }
    } finally {
      library.close()
    }
  }, person.id)
  expect(storage.profileHasPerson).toBe(true)
  expect(storage.libraryPrivateTables).toEqual([])
})

test('已有前块预览、尾块未处理时结束仍用最终混音完整转写', async () => {
  test.setTimeout(90000)
  expect((await page.evaluate(() => window.jiwei.asr.status())).state).toBe('ready')
  expect((await page.evaluate(() => window.jiwei.moss.status())).state).not.toBe('ready')
  const audio = join(modelRoot, 'whole.webm')
  execFileSync(join(models, 'ffmpeg/ffmpeg'), [
    '-nostdin',
    '-v',
    'error',
    '-i',
    resolve('e2e/fixtures/meeting.wav'),
    '-c:a',
    'libopus',
    '-y',
    audio
  ])
  const r = await page.evaluate(() =>
    window.jiwei.recording.begin({ scene: 'thought', tracks: ['mic'], participants: [], extraHotwords: '', localOnly: true })
  )
  await page.evaluate(
    ({ id, bytes }) =>
      window.jiwei.recording.chunk({ id, track: 'mic', sequence: 0, startMs: 0, durationMs: 45000, bytes: new Uint8Array(bytes) }),
    { id: r.id, bytes: [...readFileSync(audio)] }
  )
  const previewJobs = await page.evaluate(() => window.jiwei.jobs.list())
  for (const job of previewJobs.filter((j) => j.kind === 'recording.preview'))
    await page.evaluate((id) => window.jiwei.jobs.cancel(id), job.id)
  await app.evaluate(({ app }, id) => {
    const path = process.getBuiltinModule('path'),
      req = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'))
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(path.join(app.getPath('userData'), 'data/jiwei.db'))
    try {
      db.prepare('UPDATE recordings SET preview=? WHERE id=?').run(
        JSON.stringify([{ start: 0, end: 2, text: '仅前块预览', track: 'mic' }]),
        id
      )
    } finally {
      db.close()
    }
  }, r.id)
  const done = await page.evaluate((id) => window.jiwei.recording.finish(id), r.id)
  await expect
    .poll(
      async () => {
        const job = (await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.key === `transcribe:${done.sourceId}`)
        if (job?.status === 'failed') throw new Error(job.error ?? 'failed')
        return job?.status
      },
      { timeout: 15000 }
    )
    .toBe('done')
  const segments = await page.evaluate((id) => window.jiwei.segments.list(id), done.sourceId!)
  expect(segments.map((s) => s.text).join('')).not.toContain('仅前块预览')
  expect(segments.some((s) => Number(String(s.locator.value).split(',')[1]) > 38)).toBe(true)
})

test('清除所有声纹使已启动登记失效，不重新创建我或向量', async () => {
  test.skip(process.env.JIWEI_MOSS !== '1', '条件模型环境真实 CAM++ 登记与清除竞争')
  expect((await page.evaluate(() => window.jiwei.voiceprint.status())).state).toBe('ready')
  await page.evaluate(() => window.jiwei.people.clear(true))
  const bytes = [...readFileSync(resolve('e2e/fixtures/meeting.wav'))]
  const result = await page.evaluate(async (bytes) => {
    const pending = window.jiwei.voiceprint.enroll(new Uint8Array(bytes)).catch(() => {})
    await window.jiwei.people.clear(true)
    await pending
    return window.jiwei.people.list()
  }, bytes)
  expect(result).toEqual([])
  // 清除只让旧工作失效，新登记仍应可用。
  await page.evaluate((bytes) => window.jiwei.voiceprint.enroll(new Uint8Array(bytes)), bytes)
  expect((await page.evaluate(() => window.jiwei.people.list())).find((p) => p.isMe)?.voiceprints).toBe(1)
})

// 重启与换库放在文件末尾，不污染前面无 MOSS 的收尾/清除测试。
test('个人登记跨知识库保留，另一库的改名与合并在回库后更新引用及索引', async () => {
  test.setTimeout(90000)
  const me = await page.evaluate(() => window.jiwei.people.save({ name: '跨库原名', isMe: true })),
    target = await page.evaluate(() => window.jiwei.people.save({ name: '跨库目标' })),
    sourceId = randomUUID()
  await app.evaluate(
    ({ app }, { sourceId, personId }) => {
      const path = process.getBuiltinModule('path'),
        req = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json')),
        Database = req('better-sqlite3') as typeof import('better-sqlite3'),
        library = new Database(path.join(app.getPath('userData'), 'data/jiwei.db')),
        profile = new Database(path.join(app.getPath('userData'), 'profile/memory.db')),
        now = Date.now()
      try {
        library
          .prepare('INSERT INTO sources(id,title,kind,accessed_at,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?)')
          .run(sourceId, '跨库引用', 'recording', now, now, now, 'e2e')
        library
          .prepare(
            'INSERT INTO recordings(id,source_id,scene,status,tracks,started_at,participants,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
          )
          .run(sourceId, sourceId, 'meeting', 'ready', '["mic"]', now, JSON.stringify([personId, 'foreign-confirmed-person']), now, now)
        library
          .prepare(
            'INSERT INTO source_segments(id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
          )
          .run(
            sourceId,
            sourceId,
            0,
            'transcript',
            JSON.stringify({ speaker: 'S01', type: 'FragmentSelector', value: 't=0,5' }),
            '［说话人 1］跨库仍可回看原稿。',
            'fixture',
            now,
            now
          )
        library
          .prepare(
            'INSERT INTO source_segments(id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
          )
          .run(
            `${sourceId}-foreign`,
            sourceId,
            1,
            'transcript',
            JSON.stringify({ speaker: 'S02', personId: 'foreign-confirmed-person', type: 'FragmentSelector', value: 't=5,8' }),
            '［外库已确认姓名］共享资料里的原话。',
            'foreign-fixture',
            now,
            now
          )
        // 仅算法夹具向量，实际确认/登记路径由 IPC 执行，真实 CAM++ 另有条件用例。
        profile
          .prepare('INSERT INTO recording_speakers(source_id,label,centroid) VALUES (?,?,?)')
          .run(sourceId, 'S01', Buffer.from(new Float32Array([1, 0]).buffer))
      } finally {
        library.close()
        profile.close()
      }
    },
    { sourceId, personId: me.id }
  )
  await page.evaluate(({ sourceId, personId }) => window.jiwei.recording.confirm({ sourceId, label: 'S01', personId }), {
    sourceId,
    personId: me.id
  })
  expect((await page.evaluate(() => window.jiwei.people.list())).find((p) => p.id === me.id)?.voiceprints).toBe(1)
  await app.close()
  const other = join(data, 'second-library')
  writeFileSync(join(data, 'jiwei-config.json'), JSON.stringify({ dataDir: other }))
  await launch()
  expect((await page.evaluate(() => window.jiwei.people.list())).find((p) => p.id === me.id)).toMatchObject({ isMe: true, voiceprints: 1 })
  await page.evaluate((p) => window.jiwei.people.save({ name: '跨库改名后' }, p.id), target)
  await page.evaluate(({ from, to }) => window.jiwei.people.merge(from, to), { from: me.id, to: target.id })
  const r = await page.evaluate(
    (id) => window.jiwei.recording.begin({ scene: 'meeting', tracks: ['mic'], participants: [id], extraHotwords: '', localOnly: true }),
    target.id
  )
  expect(r.participants).toEqual([target.id])
  await page.evaluate((id) => window.jiwei.recording.discard(id), r.id)
  await app.close()
  writeFileSync(join(data, 'jiwei-config.json'), JSON.stringify({ dataDir: join(data, 'data') }))
  await launch()
  const people = await page.evaluate(() => window.jiwei.people.list())
  expect(people.find((p) => p.id === target.id)).toMatchObject({ name: '跨库改名后', isMe: true, voiceprints: 1 })
  expect(people.some((p) => p.id === me.id)).toBe(false)
  const segments = await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)
  expect(segments[0].locator.personId).toBe(target.id)
  expect(segments[0].text).toMatch(/^［跨库改名后］/)
  // 本机缺少另一个人的个人档案不能被当作删除，不能损失共享资料已有的文本事实。
  expect(segments[1].text).toBe('［外库已确认姓名］共享资料里的原话。')
  expect((await page.evaluate((id) => window.jiwei.recording.get(id), sourceId)).participants).toEqual([
    target.id,
    'foreign-confirmed-person'
  ])
  expect((await page.evaluate((id) => window.jiwei.recording.speakers(id), sourceId))[0]).toMatchObject({
    personId: target.id,
    hasCentroid: true
  })
  await expect.poll(() => page.evaluate(() => window.jiwei.segments.search('跨库改名后').then((s) => s.length))).toBe(1)
})
