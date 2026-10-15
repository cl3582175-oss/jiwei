import { expect, it } from 'vitest'
import { f, settle, source, start } from './digestFixture'
import { vi } from 'vitest'

it('36批中第20批暂时失败，任务续跑不重读前19批', async () => {
  const ids = await source(false, 36)
  let failures = 2
  f.beforeOutput = (prompt, map) => {
    if (map && prompt.includes(`[${ids[19]}]`) && failures-- > 0) throw new Error('HTTP 503 overloaded')
  }
  const { jobId } = await start()
  const result = await settle(jobId)
  expect(result.status, result.error ?? '').toBe('done')
  for (const id of ids.slice(0, 19))
    expect(
      f.calls.filter((p) => p.includes(`[${id}]`)),
      id
    ).toHaveLength(1)
})

it('失败步骤耗尽局部重试后，任务级重试仍复用前19批', async () => {
  const ids = await source(false, 36)
  let failures = 4
  f.beforeOutput = (prompt, map) => {
    if (map && prompt.includes(`[${ids[19]}]`) && failures-- > 0) throw new Error('HTTP 503 overloaded')
  }
  const { jobId } = await start()
  const result = await settle(jobId)
  expect(result.status, result.error ?? '').toBe('done')
  for (const id of ids.slice(0, 19))
    expect(
      f.calls.filter((p) => p.includes(`[${id}]`)),
      id
    ).toHaveLength(1)
  expect(f.sql!.prepare('SELECT attempts FROM jobs WHERE id=?').get(jobId)).toEqual({ attempts: 2 })
})

it('汇总后数据库暂不可写，手动重试只保存已有结果', async () => {
  await source(false, 2)
  f.sql!.exec("CREATE TRIGGER controlled_save_block BEFORE INSERT ON proposals BEGIN SELECT RAISE(ABORT,'database is busy'); END")
  const { jobId } = await start()
  expect((await settle(jobId)).status).toBe('failed')
  const calls = f.calls.length
  expect(calls).toBe(3)
  expect((f.sql!.prepare('SELECT count(*) AS n FROM job_steps WHERE job_id=?').get(jobId) as { n: number }).n).toBe(3)
  f.sql!.exec('DROP TRIGGER controlled_save_block')
  ;(await import('../jobs')).retryJob(jobId)
  expect((await settle(jobId)).status).toBe('done')
  expect(f.calls).toHaveLength(calls)
  expect(f.sql!.prepare('SELECT count(*) AS n FROM job_steps WHERE job_id=?').get(jobId)).toEqual({ n: 0 })
})

it('提案落库后任务完成状态写入失败，重试不会重复提案或丢失结果', async () => {
  await source(false)
  f.sql!.exec(
    "CREATE TRIGGER controlled_completion_block BEFORE UPDATE OF status ON jobs WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'database is busy'); END"
  )
  const { jobId } = await start()
  expect((await settle(jobId)).status).toBe('failed')
  expect(f.sql!.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({ n: 1 })
  const calls = f.calls.length
  f.sql!.exec('DROP TRIGGER controlled_completion_block')
  ;(await import('../jobs')).retryJob(jobId)
  expect((await settle(jobId)).status).toBe('done')
  expect(f.sql!.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({ n: 1 })
  expect(f.calls).toHaveLength(calls)
})

it('片段内容变化只使本批与汇总缓存失效', async () => {
  const ids = await source(false, 2)
  f.sql!.exec("CREATE TRIGGER controlled_save_block BEFORE INSERT ON proposals BEGIN SELECT RAISE(ABORT,'database is busy'); END")
  const { jobId } = await start()
  expect((await settle(jobId)).status).toBe('failed')
  f.sql!.prepare('UPDATE source_segments SET text=? WHERE id=?').run('changed ' + 'a'.repeat(6000), ids[1])
  f.sql!.exec('DROP TRIGGER controlled_save_block')
  ;(await import('../jobs')).retryJob(jobId)
  expect((await settle(jobId)).status).toBe('done')
  expect(f.calls.filter((p) => p.includes(`[${ids[0]}]`))).toHaveLength(1)
  expect(f.calls.filter((p) => p.includes(`[${ids[1]}]`))).toHaveLength(2)
  expect(f.calls).toHaveLength(5)
})

it('步骤内临时错误按30/60/120秒退避，永久错误立即失败', async () => {
  await source(false)
  const jobs = await import('../jobs')
  const times: number[] = []
  jobs.registerJobKind('controlled.steps', {
    title: () => 'Controlled',
    run: async (_input, ctx) =>
      ctx.step('one', 'source', async () => {
        times.push(Date.now())
        if (times.length <= 3) throw Object.assign(new Error('busy'), { statusCode: 503 })
        return 'done'
      })
  })
  jobs.startJobs()
  const id = jobs.enqueue('controlled.steps', {})
  expect((await settle(id)).status).toBe('done')
  expect(times.slice(1).map((t, i) => t - times[i])).toEqual([30_000, 60_000, 120_000])
  expect(f.sql!.prepare('SELECT attempts FROM jobs WHERE id=?').get(id)).toEqual({ attempts: 1 })
  jobs.registerJobKind('controlled.permanent', {
    title: () => 'Controlled',
    run: async () => {
      throw new jobs.PermanentJobError('Source deleted')
    }
  })
  const permanent = jobs.enqueue('controlled.permanent', {})
  expect((await settle(permanent)).status).toBe('failed')
  expect(f.sql!.prepare('SELECT attempts FROM jobs WHERE id=?').get(permanent)).toEqual({ attempts: 1 })
})

it('启动清理30天前步骤，任务记录删除同时清理它的缓存', async () => {
  const jobs = await import('../jobs')
  const id = jobs.enqueue('controlled.retained', {})
  f.sql!.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(id)
  f.sql!.prepare('INSERT INTO job_steps VALUES(?,?,?,?,?)').run(id, 'old', null, '{}', Date.now() - 31 * 86400000)
  f.sql!.prepare('INSERT INTO job_steps VALUES(?,?,?,?,?)').run(id, 'fresh', null, '{}', Date.now())
  jobs.startJobs()
  expect(f.sql!.prepare('SELECT step_key FROM job_steps WHERE job_id=?').all(id)).toEqual([{ step_key: 'fresh' }])
  f.sql!.prepare("UPDATE jobs SET status='done',updated_at=? WHERE id=?").run(Date.now() - 31 * 86400000, id)
  jobs.pruneJobs()
  expect(f.sql!.prepare('SELECT count(*) AS n FROM job_steps WHERE job_id=?').get(id)).toEqual({ n: 0 })
  await vi.advanceTimersByTimeAsync(1)
})

it('调度器中断重启后从数据库中的已完成步骤继续', async () => {
  await source(false)
  const jobs = await import('../jobs')
  let calls = 0,
    resumed = false
  jobs.registerJobKind('controlled.restart', {
    title: () => 'Controlled',
    run: async (_input, ctx) => {
      await ctx.step('first', 'source', async () => ++calls)
      if (!resumed)
        await new Promise<void>((_resolve, reject) =>
          ctx.signal!.addEventListener('abort', () => reject(ctx.signal!.reason), { once: true })
        )
      return 'done'
    }
  })
  jobs.startJobs()
  const id = jobs.enqueue('controlled.restart', {})
  await vi.advanceTimersByTimeAsync(1)
  expect(f.sql!.prepare('SELECT count(*) AS n FROM job_steps WHERE job_id=?').get(id)).toEqual({ n: 1 })
  await jobs.stopJobsAndWait()
  resumed = true
  jobs.startJobs()
  expect((await settle(id)).status).toBe('done')
  expect(calls).toBe(1)
})

it('步骤缓存写入暂时失败时保留内存中的生成结果，只重试写入', async () => {
  await source(false)
  const jobs = await import('../jobs')
  f.sql!.exec("CREATE TRIGGER controlled_step_block BEFORE INSERT ON job_steps BEGIN SELECT RAISE(ABORT,'database is busy'); END")
  let calls = 0
  jobs.registerJobKind('controlled.cache-write', {
    title: () => 'Controlled',
    run: async (_input, ctx) => ctx.step('first', 'source', async () => ++calls)
  })
  jobs.startJobs()
  const id = jobs.enqueue('controlled.cache-write', {})
  setTimeout(() => f.sql!.exec('DROP TRIGGER controlled_step_block'), 20_000)
  expect((await settle(id)).status).toBe('done')
  expect(calls).toBe(1)
})

it('缓存命中式的快速进度更新也持久化最新比例', async () => {
  const jobs = await import('../jobs')
  let release: (() => void) | undefined
  jobs.registerJobKind('controlled.progress', {
    title: () => 'Controlled',
    run: async (_input, ctx) => {
      for (let i = 1; i <= 19; i++) ctx.progress(i / 37)
      await new Promise<void>((r) => {
        release = r
        ctx.signal?.addEventListener('abort', () => r(), { once: true })
      })
    }
  })
  jobs.startJobs()
  const id = jobs.enqueue('controlled.progress', {})
  await vi.advanceTimersByTimeAsync(1)
  try {
    expect((f.sql!.prepare('SELECT progress FROM jobs WHERE id=?').get(id) as { progress: number }).progress).toBeCloseTo(19 / 37)
  } finally {
    release?.()
  }
  expect((await settle(id)).status).toBe('done')
})
