import { expect, it } from 'vitest'
import { f, source } from './digestFixture'
import { buildScopeTools } from '../ai/scopeTools'
import { enqueue } from '../jobs'
import { recordPages } from '../recognize'

it.each([true, false])('dialogue reports the actual recognition wait after confirmation (zh=%s)', async (zh) => {
  await source(false)
  f.recognition.mode = 'cloud'
  recordPages('source', [{ page: 1, need: 'scan' }])
  const { tools } = buildScopeTools(zh, { providerId: 'controlled', model: 'controlled', conversationId: 'own' })
  const result = await tools.source_digest.execute!(
    { sourceId: 'source', task: 'summary' },
    { toolCallId: 'controlled', messages: [], context: {} }
  )
  expect(result).toContain(zh ? '等待识别完成' : 'Waiting for recognition')
})

it.each([true, false])('dialogue reports parsing rather than claiming the digest has started (zh=%s)', async (zh) => {
  await source(false)
  enqueue('source.segment', { sourceId: 'source' }, { dedupeKey: 'segment:source', runAfter: Date.now() + 60_000 })
  const { tools } = buildScopeTools(zh, { providerId: 'controlled', model: 'controlled', conversationId: 'own' })
  const result = await tools.source_digest.execute!(
    { sourceId: 'source', task: 'summary' },
    { toolCallId: 'controlled', messages: [], context: {} }
  )
  expect(result).toContain(zh ? '等待资料解析完成' : 'Waiting for the source to finish parsing')
})
