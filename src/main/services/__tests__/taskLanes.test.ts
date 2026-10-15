import { expect, it } from 'vitest'
import { f } from './digestFixture'
import { enqueue, listJobs } from '../jobs'
import { replenish, registerVariantJobs } from '../mistakesVariants'
import { registerJobKinds } from '../jobKinds'

function mistake() {
  f.sql!.exec(`INSERT INTO mistakes(id,source_kind,question,concepts,created_at,updated_at,updated_by)
    VALUES('controlled-mistake','manual','Explain the core concept','["concept"]',1,7,'controlled')`)
  registerVariantJobs()
}

it('a user request promotes the queued automatic variant job without losing its revision', () => {
  mistake()
  const id = replenish('controlled-mistake')!
  expect(listJobs().find((job) => job.id === id)?.lane).toBe('background')
  expect(replenish('controlled-mistake', true)).toBe(id)
  expect(listJobs().find((job) => job.id === id)?.lane).toBe('user')
  const row = f.sql!.prepare('SELECT payload,run_after FROM jobs WHERE id=?').get(id) as { payload: string; run_after: number }
  expect(JSON.parse(row.payload)).toEqual({ id: 'controlled-mistake', revision: 7, immediate: true })
  expect(row.run_after).toBeLessThanOrEqual(Date.now())
})

it('new manual variants enter the user lane while old payloads stay in background', () => {
  mistake()
  const manual = replenish('controlled-mistake', true)!
  const legacy = enqueue('mistake-variants', { id: 'old-payload' })
  expect(listJobs().find((job) => job.id === manual)?.lane).toBe('user')
  expect(listJobs().find((job) => job.id === legacy)?.lane).toBe('background')
})

it('normal parsing and fetching use the user lane while parser upgrades stay in background', () => {
  registerJobKinds()
  const normal = enqueue('source.segment', { sourceId: 'normal' })
  const upgrade = enqueue('source.segment', { sourceId: 'upgrade', upgrade: true })
  const fetch = enqueue('source.fetch', { sourceId: 'fetch' })
  const lanes = listJobs()
  expect(lanes.find((job) => job.id === normal)?.lane).toBe('user')
  expect(lanes.find((job) => job.id === upgrade)?.lane).toBe('background')
  expect(lanes.find((job) => job.id === fetch)?.lane).toBe('user')
})
