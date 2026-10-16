import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_PARSE_VERSION } from '@shared/formats'

const f = vi.hoisted(() => ({ sql: null as Database.Database | null, db: null as ReturnType<typeof drizzle> | null, enabled: true }))
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('electron', () => ({
  utilityProcess: {},
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  app: { getPath: () => '', getLocale: () => 'zh-CN' }
}))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {} } }))
vi.mock('../settings', () => ({ getSettings: () => ({ retrieval: { autoUpgrade: f.enabled } }) }))
vi.mock('../recognize', () => ({
  IMAGE_EXTS: new Set(['png']),
  applyRecognized: () => {},
  recordPages: () => {},
  maybeAutoRecognize: () => {}
}))
vi.mock('../ai/indexer', () => ({ requestIndex: () => {} }))
vi.mock('../plan/ics', () => ({ registerIcsJobs: () => {} }))
import { setOffPeakPolicy, startJobs, stopJobs } from '../jobs'
import { emit } from '../../events'
import { startSourceUpgrade, stopSourceUpgrade, scheduleSourceUpgrade, sourceUpgradeStatus } from '../sourceUpgrade'

beforeEach(() => {
  vi.useFakeTimers()
  stopJobs()
  f.enabled = true
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  f.db = drizzle(f.sql)
  const dir = join(process.cwd(), 'resources/migrations')
  for (const p of readdirSync(dir)
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(dir, p), 'utf8'))
  f.sql.exec("INSERT INTO assets(id,ext,size,created_at) VALUES('asset','docx',1,1)")
  for (const [id, created] of [
    ['older', 1],
    ['newer', 2]
  ] as const)
    f.sql
      .prepare('INSERT INTO sources(id,title,kind,asset_id,accessed_at,created_at,updated_at) VALUES(?,?,?,?,1,?,1)')
      .run(id, '合成资料', 'document', 'asset', created)
  setOffPeakPolicy((at) => at + 60000)
  startJobs()
})
afterEach(() => {
  stopSourceUpgrade()
  stopJobs()
  setOffPeakPolicy(null)
  f.sql?.close()
  vi.useRealTimers()
})
const queued = () =>
  f.sql!.prepare("SELECT payload,run_after FROM jobs WHERE kind='source.segment' AND status='queued'").all() as {
    payload: string
    run_after: number
  }[]

it('upgrades old private project PDFs locally without making them globally readable', async () => {
  f.sql!.exec(`INSERT INTO assets(id,ext,size,created_at) VALUES('pdf','pdf',1,1);
    UPDATE sources SET ai_excluded=1 WHERE id='older';
    UPDATE sources SET space='attachment',ai_excluded=1,asset_id='pdf',kind='pdf',parse_version=2 WHERE id='newer';
    INSERT INTO chat_projects(id,name,created_at,updated_at) VALUES('project','Synthetic',1,1);
    INSERT INTO project_sources(project_id,item_type,item_id,origin,created_at) VALUES('project','source','newer','upload',1);`)
  startSourceUpgrade()
  await vi.advanceTimersByTimeAsync(300000)
  expect(queued().map((j) => JSON.parse(j.payload))).toEqual([{ sourceId: 'newer', upgrade: true }])
  expect(f.sql!.prepare("SELECT ai_excluded,space FROM sources WHERE id='newer'").get()).toEqual({ ai_excluded: 1, space: 'attachment' })
})

it('启动五分钟后从新到旧一次排一份，沿用去重键与低谷调度', async () => {
  startSourceUpgrade()
  expect(queued()).toEqual([])
  await vi.advanceTimersByTimeAsync(300000)
  expect(queued()).toHaveLength(1)
  expect(JSON.parse(queued()[0].payload)).toMatchObject({ sourceId: 'newer', upgrade: true })
  expect(queued()[0].run_after).toBeGreaterThan(Date.now())
  scheduleSourceUpgrade()
  expect(queued()).toHaveLength(1)
  f.sql!.prepare("UPDATE sources SET parse_version=? WHERE id='newer'").run(CURRENT_PARSE_VERSION)
  f.sql!.exec("UPDATE jobs SET status='done'")
  scheduleSourceUpgrade()
  expect(JSON.parse(queued()[0].payload).sourceId).toBe('older')
  expect(sourceUpgradeStatus()).toEqual({ total: 2, done: 1, running: true, paused: false })
})
it('关闭会取消尚未执行的自动升级，普通解析任务保持有效', async () => {
  startSourceUpgrade()
  await vi.advanceTimersByTimeAsync(300000)
  scheduleSourceUpgrade()
  expect(queued()).toHaveLength(1)
  f.enabled = false
  emit('retrieval:changed', {})
  await vi.runOnlyPendingTimersAsync()
  expect(queued()).toEqual([])
  expect(sourceUpgradeStatus()).toMatchObject({ paused: true, running: false })
  f.enabled = true
  scheduleSourceUpgrade()
  expect(queued()).toHaveLength(1)
})
it('默认不升级附件、排除/删除资料、录音和带转写的课程，失败记录跨调度不重试', async () => {
  f.sql!.exec("UPDATE sources SET space='attachment' WHERE id='newer';UPDATE sources SET ai_excluded=1 WHERE id='older'")
  startSourceUpgrade()
  await vi.advanceTimersByTimeAsync(300000)
  scheduleSourceUpgrade()
  expect(queued()).toEqual([])
  f.sql!.exec(
    "UPDATE sources SET ai_excluded=0 WHERE id='older';INSERT INTO jobs(id,kind,payload,status,run_after,created_at,updated_at) VALUES('failed','source.segment','{\"sourceId\":\"older\"}','failed',1,1,1)"
  )
  scheduleSourceUpgrade()
  scheduleSourceUpgrade()
  expect(queued()).toEqual([])
  expect(f.sql!.prepare('SELECT parse_version FROM sources WHERE id=?').get('older')).toEqual({ parse_version: -1 })
  expect(sourceUpgradeStatus()).toEqual({ total: 0, done: 0, running: false, paused: false })
})

it('设置和普通作业事件不能绕过启动五分钟等待', async () => {
  startSourceUpgrade()
  emit('retrieval:changed', {})
  await vi.advanceTimersByTimeAsync(1000)
  expect(queued()).toEqual([])
  await vi.advanceTimersByTimeAsync(299000)
  expect(queued()).toHaveLength(1)
})

it('重开时已有的自动升级仍等五分钟，普通解析保持原调度且关闭能立即取消自动任务', () => {
  const now = Date.now()
  const insert = f.sql!.prepare(
    "INSERT INTO jobs(id,kind,payload,dedupe_key,status,run_after,created_at,updated_at) VALUES(?,'source.segment',?,?,'queued',?,?,?)"
  )
  insert.run('auto', JSON.stringify({ sourceId: 'older', upgrade: true }), 'segment:older', now - 1, now, now)
  insert.run('ordinary', JSON.stringify({ sourceId: 'newer' }), 'segment:newer', now - 1, now, now)
  startSourceUpgrade()
  const automatic = queued().find((j) => JSON.parse(j.payload).upgrade)!
  const ordinary = queued().find((j) => !JSON.parse(j.payload).upgrade)!
  expect(automatic.run_after).toBeGreaterThanOrEqual(now + 300000)
  expect(ordinary.run_after).toBe(now - 1)
  f.enabled = false
  scheduleSourceUpgrade()
  expect(queued()).toEqual([ordinary])
})
