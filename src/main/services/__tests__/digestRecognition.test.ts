import { expect, it, vi } from 'vitest'
import { f, settle, source } from './digestFixture'
import * as scheduler from '../jobs'
import * as digest from '../digest'
import * as recognition from '../recognize'
import { listSegments, replaceSegments } from '../segments'

const input = { sourceId: 'source', conversationId: 'own', task: 'summary' as const, providerId: 'controlled', model: 'controlled' }
async function prepare(pages: number[], text = true) {
  await source(false, 0)
  f.sql!.exec("INSERT INTO assets(id,ext,size,created_at) VALUES('asset','pdf',1,1); UPDATE sources SET asset_id='asset' WHERE id='source'")
  if (text) replaceSegments('source', [{ kind: 'text', text: '原有文字内容。', locator: { value: 'page=1' } }])
  recognition.recordPages(
    'source',
    pages.map((page) => ({ page, need: 'scan' }))
  )
  f.recognition.mode = 'cloud'
  recognition.registerRecognizeJob()
  digest.registerDigestJob()
}
const state = (id: string) => scheduler.listJobs().find((j) => j.id === id)!
const proposalText = () => String((f.sql!.prepare('SELECT ops FROM proposals').get() as { ops: string }).ops)

it('waits before any digest step, wakes within seconds and reads the newly recognized segments', async () => {
  await prepare([1, 2])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.beforePage = async () => gate
  const { jobId } = digest.startDigest({ ...input, fromPage: 1, toPage: 2 })
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(1)
  expect(state(jobId)).toMatchObject({ status: 'queued', attempts: 0, waiting: { reason: 'recognition', done: 0, total: 2 } })
  expect(f.sql!.prepare('SELECT count(*) n FROM job_steps WHERE job_id=?').get(jobId)).toEqual({ n: 0 })
  const began = Date.now()
  release()
  await vi.advanceTimersByTimeAsync(2000)
  expect(state(jobId).status).toBe('done')
  expect(Date.now() - began).toBeLessThan(60_000)
  expect(f.calls.join('\n')).toContain('扫描第2页识别后的核心文字')
  expect(listSegments('source').some((s) => s.kind === 'ocr:scan')).toBe(true)
  expect(state(jobId).attempts).toBe(1)
})

it('with automatic recognition disabled, a digest queues recognition for only its range; manual start later covers all pages', async () => {
  await prepare([1, 2, 3, 4])
  const { jobId } = digest.startDigest({ ...input, fromPage: 2, toPage: 3 })
  expect(scheduler.listJobs().find((j) => j.kind === 'source.recognize')?.lane).toBe('user')
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  expect(f.recognized).toEqual([2, 3])
  recognition.startRecognition('source')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.recognized).toEqual([2, 3, 1, 4])
})

it('manual start upgrades an already queued digest-only recognition payload to full', async () => {
  await prepare([1, 2, 3])
  digest.startDigest({ ...input, fromPage: 2, toPage: 2 })
  const before = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  recognition.startRecognition('source')
  const rows = f.sql!.prepare("SELECT id,payload FROM jobs WHERE kind='source.recognize'").all() as { id: string; payload: string }[]
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe(before.id)
  expect(JSON.parse(rows[0].payload).full).toBe(true)
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.recognized).toEqual([2, 1, 3])
})

it('manual start during an active scoped recognition retains a full follow-up rather than losing the request', async () => {
  await prepare([1, 2, 3])
  let release!: () => void
  f.beforePage = async () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const { jobId } = digest.startDigest({ ...input, fromPage: 2, toPage: 2 })
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(1)
  recognition.startRecognition('source')
  f.beforePage = async () => {}
  release()
  expect((await settle(jobId)).status).toBe('done')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.recognized).toEqual([2, 1, 3])
})

it('prioritizes every queued digest range before remaining automatic work', async () => {
  await prepare([1, 2, 3, 4])
  f.recognition.auto = true
  digest.startDigest({ ...input, fromPage: 3, toPage: 3 })
  digest.startDigest({ ...input, fromPage: 4, toPage: 4 })
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.recognized).toEqual([3, 4, 1, 2])
})

it('digestNow removes the wait and adds a normal proposal line listing pending pages', async () => {
  await prepare([3, 17, 20])
  const { jobId } = digest.startDigest(input)
  const recognitionJob = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  f.sql!.prepare('UPDATE jobs SET run_after=? WHERE id=?').run(Date.now() + 300_000, recognitionJob.id)
  digest.digestNow(jobId)
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  expect(f.recognized).toEqual([])
  expect(proposalText()).toContain('第 3、17、20 页未能识别，未纳入整理。')
  expect(state(jobId).waiting).toBeNull()
})

it('failed pages never hold up a digest and are listed with at most ten page numbers', async () => {
  await prepare(Array.from({ length: 12 }, (_, i) => i + 1))
  f.sql!.exec("UPDATE source_pages SET status='failed'")
  const { jobId } = digest.startDigest(input)
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  expect(f.recognized).toEqual([])
  expect(proposalText()).toContain('第 1、2、3、4、5、6、7、8、9、10 等 12 页未能识别，未纳入整理。')
})

it('an all-scan source is accepted into waiting rather than rejected for having no text', async () => {
  await prepare([1], false)
  const { jobId } = digest.startDigest(input)
  expect(state(jobId).waiting?.reason).toBe('recognition')
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  expect(f.calls.join('\n')).toContain('扫描第1页识别后的核心文字')
})

it.each(['off', 'no-vision'] as const)(
  'an unavailable %s engine does not block and the confirmation explains missing pages in both languages',
  async (unavailable) => {
    await prepare([2])
    if (unavailable === 'off') f.recognition.mode = 'off'
    else f.vision = false
    expect(recognition.pendingRecognition('source').pending).toEqual([])
    expect(digest.describeDigest(input, true).detail).toContain('当前没有可用的识别，整理会缺这些页')
    expect(digest.describeDigest(input, false).detail).toContain('will be missing')
    const { jobId } = digest.startDigest(input)
    expect(state(jobId).waiting).toBeNull()
    scheduler.startJobs()
    expect((await settle(jobId)).status).toBe('done')
    expect(proposalText()).toContain('第 2 页未能识别，未纳入整理。')
  }
)

it('confirmation explains that recognition can increase the content and cost', async () => {
  await prepare([1, 2])
  expect(digest.describeDigest(input, true).detail).toContain('其中 2 页是图片或扫描页，会先识别再整理')
  expect(digest.describeDigest(input, false).detail).toContain('2 pages are images or scans and will be recognized first')
})

it('counts unique pages and treats done, skipped and failed as completed for wait progress', async () => {
  await prepare([1, 2, 3, 4])
  f.sql!.exec(
    "UPDATE source_pages SET status='done' WHERE page=1; UPDATE source_pages SET status='skipped' WHERE page=2; UPDATE source_pages SET status='failed' WHERE page=3"
  )
  f.sql!.exec("INSERT INTO source_pages(source_id,page,need,status,updated_at) VALUES('source',4,'table','pending',1)")
  expect(recognition.pendingRecognition('source', 1, 4)).toEqual({ pending: [4], done: 3, total: 4 })
})

it('parse completion wakes a waiting digest after the parser status becomes terminal, including auto=false', async () => {
  await prepare([], false)
  const { registerJobKinds } = await import('../jobKinds')
  registerJobKinds()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.beforePage = async (page) => {
    if (page === 0) await gate
  }
  f.parseResult = { segments: [], pages: [{ page: 1, need: 'scan' }] }
  scheduler.enqueue('source.segment', { sourceId: 'source' }, { dedupeKey: 'segment:source' })
  const { jobId } = digest.startDigest(input)
  expect(state(jobId).waiting).toEqual({ reason: 'parsing' })
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(1)
  expect(state(jobId).waiting).toEqual({ reason: 'parsing' })
  release()
  await vi.advanceTimersByTimeAsync(2000)
  expect(state(jobId).status).toBe('done')
  expect(f.recognized).toEqual([1])
})

it('canceling a scoped digest preserves the current page result and stops taking unrelated pages', async () => {
  await prepare([1, 2, 3])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.beforePage = async () => gate
  const { jobId } = digest.startDigest(input)
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(1)
  scheduler.cancelJob(jobId)
  release()
  await vi.advanceTimersByTimeAsync(2000)
  expect(state(jobId).status).toBe('canceled')
  expect(f.recognized).toEqual([1])
  expect(scheduler.listJobs().find((j) => j.kind === 'source.recognize')?.status).toBe('done')
  expect(listSegments('source').some((s) => s.text.includes('扫描第1页'))).toBe(true)
})

it('deleted sources fail permanently before waiting or model work', async () => {
  await prepare([1])
  const { jobId } = digest.startDigest(input)
  f.sql!.exec("UPDATE sources SET deleted_at=1 WHERE id='source'")
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('failed')
  expect(state(jobId).attempts).toBe(1)
  expect(f.calls).toEqual([])
})

it('promotes running automatic recognition at the next page boundary and publishes that page before resuming', async () => {
  await prepare([1, 2, 3, 4])
  f.recognition.auto = true
  let releaseFirst!: () => void, releaseUrgent!: () => void
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const urgent = new Promise<void>((resolve) => {
    releaseUrgent = resolve
  })
  f.beforePage = async (page) => {
    if (page === 1) await first
    if (page === 3) await urgent
  }
  recognition.maybeAutoRecognize('source')
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(1)
  const rec = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  expect(rec.lane).toBe('background')
  const { jobId } = digest.startDigest({ ...input, fromPage: 3, toPage: 3 })
  await vi.advanceTimersByTimeAsync(1)
  releaseFirst()
  await vi.advanceTimersByTimeAsync(1)
  expect(state(rec.id).lane).toBe('user')
  expect(listSegments('source').some((s) => s.text.includes('扫描第1页'))).toBe(true)
  releaseUrgent()
  expect((await settle(jobId)).status).toBe('done')
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.recognized).toEqual([1, 3, 2, 4])
})

it('a page failure wakes the digest without retrying that page indefinitely', async () => {
  await prepare([2])
  f.beforePage = async () => {
    throw new Error('controlled unreadable page')
  }
  const { jobId } = digest.startDigest(input)
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(2000)
  expect(state(jobId).status).toBe('done')
  expect(proposalText()).toContain('第 2 页未能识别，未纳入整理。')
  expect(f.sql!.prepare('SELECT status FROM source_pages').get()).toEqual({ status: 'failed' })
})

it('a noWait proposal keeps the omissions of its input snapshot when OCR finishes during generation', async () => {
  await prepare([2])
  const { jobId } = digest.startDigest(input)
  const rec = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  f.sql!.prepare('UPDATE jobs SET run_after=? WHERE id=?').run(Date.now() + 300_000, rec.id)
  digest.digestNow(jobId)
  f.beforeOutput = (_prompt, map) => {
    if (!map) return
    f.sql!.exec("UPDATE source_pages SET status='done',text='生成期间才识别出的文字' WHERE page=2")
    recognition.applyRecognized('source')
  }
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  expect(f.calls.join('\n')).not.toContain('生成期间才识别出的文字')
  expect(proposalText()).toContain('第 2 页未能识别，未纳入整理。')
})

it('a noWait digest includes completed OCR that had not reached the ten-page publication batch', async () => {
  await prepare([2])
  f.sql!.exec("UPDATE source_pages SET status='done',text='已经识别但尚未并入的文字' WHERE page=2")
  const { jobId } = digest.startDigest(input)
  digest.digestNow(jobId)
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  expect(f.calls.join('\n')).toContain('已经识别但尚未并入的文字')
})

it('all OCR failures remain failed beyond the automatic retry window and panel retry processes only the failed scope', async () => {
  await prepare([1, 2, 3])
  f.beforePage = async () => {
    throw new Error('controlled unreadable page')
  }
  const { jobId } = digest.startDigest({ ...input, fromPage: 1, toPage: 2 })
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  const rec = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  await vi.advanceTimersByTimeAsync(300_000)
  expect(state(rec.id).status).toBe('failed')
  expect(state(rec.id).attempts).toBe(1)
  f.beforePage = async () => {}
  scheduler.retryJob(rec.id)
  await vi.advanceTimersByTimeAsync(2000)
  expect(state(rec.id).status).toBe('done')
  expect(f.recognized).toEqual([1, 2])
  expect(f.sql!.prepare('SELECT status FROM source_pages WHERE page=3').get()).toEqual({ status: 'pending' })
  expect(JSON.parse((f.sql!.prepare('SELECT result FROM jobs WHERE id=?').get(rec.id) as { result: string }).result)).toEqual({
    done: 2,
    failed: 0
  })
})

it('page failures and successful results survive a yield without re-recognizing the failed page', async () => {
  await prepare([1, 2])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.beforePage = async (page) => {
    if (page === 1) {
      await gate
      throw new Error('controlled failed first page')
    }
  }
  recognition.startRecognition('source')
  scheduler.registerJobKind('recognition.blocker', {
    title: () => '',
    run: async (_, ctx) => {
      await new Promise<void>((resolve) => ctx.signal!.addEventListener('abort', () => resolve(), { once: true }))
    }
  })
  const firstBlocker = scheduler.enqueue('recognition.blocker', {})
  scheduler.enqueue('recognition.blocker', {})
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(180_001)
  const rec = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  release()
  await vi.advanceTimersByTimeAsync(1)
  expect(state(rec.id).yielded).toBe(true)
  scheduler.cancelJob(firstBlocker)
  await vi.advanceTimersByTimeAsync(2000)
  expect(state(rec.id).status).toBe('done')
  expect(f.recognized).toEqual([2])
  expect(JSON.parse((f.sql!.prepare('SELECT result FROM jobs WHERE id=?').get(rec.id) as { result: string }).result)).toEqual({
    done: 1,
    failed: 1
  })
})

it.each(['queued', 'running'] as const)(
  'legacy manual recognition payloads resume full recognition from %s with auto=false',
  async (status) => {
    await prepare([1, 2])
    const id = scheduler.enqueue('source.recognize', { sourceId: 'source' }, { dedupeKey: 'recognize:source' })
    f.sql!.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, id)
    scheduler.startJobs()
    await vi.advanceTimersByTimeAsync(2000)
    expect(state(id).status).toBe('done')
    expect(f.recognized).toEqual([1, 2])
  }
)

it('a forced all-scan digest with no recognized text fails clearly rather than creating an empty proposal', async () => {
  await prepare([1], false)
  const { jobId } = digest.startDigest(input)
  const rec = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  f.sql!.prepare('UPDATE jobs SET run_after=? WHERE id=?').run(Date.now() + 300_000, rec.id)
  digest.digestNow(jobId)
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('failed')
  expect(state(jobId).error).toContain('No text in this range')
  expect(state(jobId).attempts).toBe(1)
  expect(f.sql!.prepare('SELECT count(*) n FROM proposals').get()).toEqual({ n: 0 })
})

it('an expired scoped retry checkpoint stays failed instead of expanding recognition or claiming empty success', async () => {
  await prepare([1, 2])
  f.beforePage = async () => {
    throw new Error('controlled unreadable page')
  }
  const { jobId } = digest.startDigest({ ...input, fromPage: 1, toPage: 1 })
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  const rec = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  expect(rec.status).toBe('failed')
  f.sql!.prepare('DELETE FROM job_steps WHERE job_id=?').run(rec.id)
  expect(() => scheduler.retryJob(rec.id)).toThrow('检查点已过期')
  expect(state(rec.id).status).toBe('failed')
  expect(f.sql!.prepare('SELECT page,status FROM source_pages ORDER BY page').all()).toEqual([
    { page: 1, status: 'failed' },
    { page: 2, status: 'pending' }
  ])
})

it('canceling recognition while a digest waits starts the digest with existing text instead of re-queueing recognition', async () => {
  await prepare([2, 3])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.beforePage = async () => gate
  const { jobId } = digest.startDigest(input)
  scheduler.startJobs()
  await vi.advanceTimersByTimeAsync(1)
  const rec = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  scheduler.cancelJob(rec.id)
  release()
  expect((await settle(jobId)).status).toBe('done')
  await vi.advanceTimersByTimeAsync(120_000)
  const recognitions = scheduler.listJobs().filter((j) => j.kind === 'source.recognize')
  expect(recognitions.map((j) => j.status)).toEqual(['canceled'])
  expect(proposalText()).toMatch(/第 [23、]+ 页未能识别，未纳入整理。/)
})

it('a recognition job that ends failed with pages still pending does not keep the digest waiting', async () => {
  await prepare([2])
  const { jobId } = digest.startDigest(input)
  const rec = scheduler.listJobs().find((j) => j.kind === 'source.recognize')!
  f.sql!.prepare("UPDATE jobs SET status='failed', updated_at=? WHERE id=?").run(Date.now() + 1, rec.id)
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  expect(scheduler.listJobs().filter((j) => j.kind === 'source.recognize')).toHaveLength(1)
  expect(proposalText()).toContain('第 2 页未能识别，未纳入整理。')
})

it('pages whose type the current settings do not recognize are not reported as missing', async () => {
  await prepare([])
  recognition.recordPages('source', [{ page: 5, need: 'figure' }])
  f.recognition.figures = false
  const { jobId } = digest.startDigest(input)
  expect(state(jobId).waiting).toBeNull()
  expect(digest.describeDigest(input, true).detail).not.toContain('图片或扫描页')
  scheduler.startJobs()
  expect((await settle(jobId)).status).toBe('done')
  expect(proposalText()).not.toContain('未能识别')
})
