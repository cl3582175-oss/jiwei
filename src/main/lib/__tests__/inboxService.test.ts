import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTableName, Param, SQL } from 'drizzle-orm'
import { inboxItems } from '../../db/schema'
import type { JobKind } from '../../services/jobs'

type Row = typeof inboxItems.$inferSelect
const state = vi.hoisted(() => ({
  rows: [] as Row[],
  recordingSources: [] as { id: string; aiExcluded: boolean; deletedAt: number | null }[],
  goals: [{ id: 'goal', title: '方向' }],
  settings: {
    language: 'zh-CN',
    capture: { daily: true, time: '21:00', offPeak: false },
    ai: { chat: { providerId: 'test-provider' as string | null, model: 'deepseek-flash' as string | null } }
  },
  meta: null as string | null,
  enqueue: vi.fn(),
  retryOrEnqueue: vi.fn(),
  originalExists: true,
  structured: vi.fn<(input: { prompt: string }) => Promise<unknown>>(),
  similar: vi.fn(),
  recognize: vi.fn(),
  installed: false,
  invalidNotes: new Set<string>(),
  jobs: new Map<string, JobKind>(),
  notification: vi.fn()
}))
function params(sql: unknown): unknown[] {
  if (sql instanceof Param) return [sql.value]
  if (sql instanceof SQL) return sql.queryChunks.flatMap(params)
  return []
}
// 仅模拟存储适配与模型边界，真实 SQLite/Yjs 归档由 Electron 用例覆盖。
vi.mock('../../db', () => {
  // 与真实 DB 服务保持相同连接身份，允许异步任务检测知识库切换。
  const db = {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => {
        const name = getTableName(table)
        let condition: unknown
        const all = () => (name === 'goals' ? state.goals : state.rows.filter((r) => !r.deletedAt))
        const query = {
          where: (sql: unknown) => {
            condition = sql
            return query
          },
          orderBy: () => query,
          all,
          get: () =>
            name === 'assets'
              ? { id: params(condition)[0], ext: 'png', mime: 'image/png' }
              : name === 'sources'
                ? state.recordingSources.find((r) => r.id === params(condition)[0])
                : state.rows.find((r) => r.id === params(condition)[0])
        }
        return query
      }
    }),
    update: () => ({
      set: (patch: Partial<Row>) => ({
        where: (sql: unknown) => ({
          run: () => {
            const row = state.rows.find((r) => r.id === params(sql)[0])
            if (row) Object.assign(row, patch)
          }
        })
      })
    }),
    transaction: (fn: () => unknown) => fn()
  }
  return { getDb: () => db }
})
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: {
    createFromPath: () => ({
      getSize: () => ({ width: 100, height: 100 }),
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,fixture'
    })
  },
  Notification: class {
    static isSupported() {
      return true
    }
    constructor(input: unknown) {
      state.notification(input)
    }
    on() {}
    show() {}
  }
}))
vi.mock('node:fs', () => ({ existsSync: () => state.originalExists }))
vi.mock('../../events', () => ({ emit: vi.fn() }))
vi.mock('../../services/assets', () => ({ assetUrl: vi.fn(), assetPath: vi.fn(), importBytes: vi.fn() }))
vi.mock('../../services/device', () => ({ deviceId: () => 'test-device' }))
vi.mock('../../services/notes', () => ({
  createNote: vi.fn(),
  getNote: (id: string) => ({ id, kind: state.invalidNotes.has(id) ? 'freeform' : 'cornell', aiExcluded: false, deletedAt: null })
}))
vi.mock('../../services/proposals', () => ({ createProposal: vi.fn(), listProposals: vi.fn(), resolveOp: vi.fn() }))
vi.mock('../../services/docs', () => ({ loadDoc: vi.fn(), pushUpdate: vi.fn(), stateToJSON: vi.fn() }))
vi.mock('../../services/reflection', () => ({ createAction: vi.fn() }))
vi.mock('../../services/sources', () => ({ addUrl: vi.fn(), importPaths: vi.fn() }))
vi.mock('../../services/settings', () => ({ getSettings: () => state.settings }))
vi.mock('../../services/memory', () => ({
  getMeta: () => state.meta,
  setMeta: (_key: string, value: string) => {
    state.meta = value
  }
}))
vi.mock('../../services/jobs', () => ({
  enqueue: state.enqueue,
  retryOrEnqueue: state.retryOrEnqueue,
  registerJobKind: (kind: string, def: JobKind) => state.jobs.set(kind, def)
}))
vi.mock('../../services/recognize', () => ({ localRecognizerInstalled: () => state.installed, recognizeRegionDetailed: state.recognize }))
vi.mock('../../services/ai/structured', () => ({ structured: state.structured }))
vi.mock('../../services/ai/retrieve', () => ({ similarTo: state.similar }))
import { accept, checkInboxSchedule, registerInboxJobs, retryRecognition, triage } from '../../services/inbox'
const row = (id: string): Row => ({
  id,
  kind: 'text',
  text: '甲'.repeat(5000),
  recognized: '乙'.repeat(5000),
  assetId: null,
  origin: '{}',
  status: 'new',
  suggestion: null,
  filedTo: null,
  recognitionStatus: 'none',
  createdAt: new Date(2026, 9, 9, 23, 59).getTime(),
  updatedAt: 1,
  updatedBy: 'test',
  deletedAt: null
})
beforeEach(() => {
  state.rows = [row('item')]
  state.recordingSources = []
  state.meta = null
  state.settings.capture = { daily: true, time: '21:00', offPeak: false }
  state.settings.ai.chat = { providerId: 'test-provider', model: 'deepseek-flash' }
  state.originalExists = true
  state.settings.language = 'zh-CN'
  state.retryOrEnqueue.mockReset().mockReturnValue('attempt')
  state.enqueue.mockReset()
  state.structured.mockReset()
  state.similar.mockReset().mockResolvedValue([])
  state.notification.mockReset()
  state.invalidNotes.clear()
  state.installed = false
  state.recognize.mockReset().mockResolvedValue({ text: '新识别原文', blocks: [], engine: 'test' })
})
describe('inbox service boundaries', () => {
  it('上一批处理期间切换仅本地，下一批连候选嵌入也不调用', async () => {
    state.rows = Array.from({ length: 11 }, (_, i) => row(`item-${i}`))
    state.rows[10].origin = JSON.stringify({ recordingSourceId: 'voice-source' })
    state.recordingSources = [{ id: 'voice-source', aiExcluded: false, deletedAt: null }]
    state.structured.mockImplementation(async ({ prompt }) => {
      state.recordingSources[0].aiExcluded = true
      const material = JSON.parse(prompt) as { items: { id: string }[] }
      return { suggestions: material.items.map((i) => ({ id: i.id, suggestion: { type: 'idea', action: 'keep', reason: 'reason' } })) }
    })
    expect(await triage()).toBe(10)
    expect(state.similar).toHaveBeenCalledTimes(10)
    expect(state.structured).toHaveBeenCalledTimes(1)
    expect(state.rows[10].status).toBe('new')
  })
  it('切换仅本地发生在候选检索期间时，不把录音材料发送给模型', async () => {
    state.rows[0].origin = JSON.stringify({ recordingSourceId: 'voice-source' })
    state.recordingSources = [{ id: 'voice-source', aiExcluded: false, deletedAt: null }]
    state.similar.mockImplementation(async () => {
      state.recordingSources[0].aiExcluded = true
      return []
    })
    expect(await triage()).toBe(0)
    expect(state.similar).toHaveBeenCalledTimes(1)
    expect(state.structured).not.toHaveBeenCalled()
    expect(state.rows[0].status).toBe('new')
  })
  it('模型返回前录音切换仅本地时不落盘迟到的整理建议', async () => {
    state.rows[0].origin = JSON.stringify({ recordingSourceId: 'voice-source' })
    state.recordingSources = [{ id: 'voice-source', aiExcluded: false, deletedAt: null }]
    state.structured.mockImplementation(async () => {
      state.recordingSources[0].aiExcluded = true
      return { suggestions: [{ id: 'item', suggestion: { type: 'idea', action: 'keep', reason: 'reason' } }] }
    })
    expect(await triage()).toBe(0)
    expect(state.rows[0].suggestion).toBeNull()
  })
  it('batches ten, truncates each input, allows only three unique notes and validates returned ids/dates', async () => {
    state.rows = Array.from({ length: 12 }, (_, i) => row(`item-${i}`))
    state.similar.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ parentType: 'note', parentId: `note-${i}`, title: `笔记${i}`, sim: 0.8 }))
    )
    state.structured.mockImplementation(async ({ prompt }) => {
      const material = JSON.parse(prompt) as { items: { id: string; text: string; recognized: string; candidates: unknown[] }[] }
      expect(material.items.length).toBeLessThanOrEqual(10)
      for (const i of material.items) {
        expect(i.text.length).toBe(4000)
        expect(i.recognized.length).toBe(4000)
        expect(i.candidates).toHaveLength(3)
      }
      return {
        suggestions: material.items.map((i) => ({
          id: i.id,
          suggestion: {
            type: 'todo',
            action: 'append_note',
            noteId: 'foreign',
            goalId: 'foreign',
            dueAt: '明天',
            groupWith: ['foreign'],
            reason: 'reason'
          }
        }))
      }
    })
    expect(await triage()).toBe(12)
    expect(state.structured).toHaveBeenCalledTimes(2)
    expect(JSON.parse(state.rows[0].suggestion!)).toMatchObject({ action: 'new_note', dueAt: '2026-10-10', groupWith: [] })
    expect(JSON.parse(state.rows[0].suggestion!)).not.toHaveProperty('noteId')
    expect(JSON.parse(state.rows[0].suggestion!)).not.toHaveProperty('goalId')
  })
  it('does not overwrite a capture changed while model request is in flight', async () => {
    state.structured.mockImplementation(async () => {
      state.rows[0].updatedAt = 2
      return { suggestions: [{ id: 'item', suggestion: { type: 'idea', action: 'keep', reason: 'reason' } }] }
    })
    expect(await triage()).toBe(0)
    expect(state.rows[0].status).toBe('new')
  })
  it('canceled jobs commit no suggestions and emit no completion notification', async () => {
    registerInboxJobs()
    let canceled = false
    state.structured.mockImplementation(async () => {
      canceled = true
      return { suggestions: [{ id: 'item', suggestion: { type: 'idea', action: 'keep', reason: 'reason' } }] }
    })
    await state.jobs
      .get('inbox.triage')!
      .run({}, { step: directStep, isCanceled: () => canceled, progress: () => undefined, worker: async <T>() => undefined as T })
    expect(state.rows[0].status).toBe('new')
    expect(state.notification).not.toHaveBeenCalled()
  })
  it('schedules once after restart and handles backward/forward clock shifts', () => {
    checkInboxSchedule(new Date(2026, 9, 9, 20, 59))
    expect(state.enqueue).not.toHaveBeenCalled()
    checkInboxSchedule(new Date(2026, 9, 9, 23))
    expect(state.enqueue).toHaveBeenCalledTimes(1)
    checkInboxSchedule(new Date(2026, 9, 9, 23, 30))
    checkInboxSchedule(new Date(2026, 9, 8, 23))
    expect(state.enqueue).toHaveBeenCalledTimes(1)
    checkInboxSchedule(new Date(2026, 9, 10, 22))
    expect(state.enqueue).toHaveBeenCalledTimes(2)
  })
  it('missing model does not consume the day; half-price runAfter is persisted for later workers', () => {
    state.settings.ai.chat.model = null
    checkInboxSchedule(new Date(2026, 9, 9, 23))
    expect(state.meta).toBeNull()
    expect(state.enqueue).not.toHaveBeenCalled()
    state.settings.ai.chat.model = 'deepseek-flash'
    state.settings.capture.offPeak = true
    state.settings.capture.time = '00:00'
    checkInboxSchedule(new Date('2026-10-09T02:00:00Z'))
    expect(state.enqueue).toHaveBeenCalledWith(
      'inbox.triage',
      {},
      { dedupeKey: 'inbox.daily', runAfter: Date.parse('2026-10-09T04:00:00Z') }
    )
  })
})

const context = (isCanceled = () => false) => ({
  step: directStep,
  isCanceled,
  progress: () => undefined,
  worker: async <T>() => undefined as T
})
const output = (id = 'item') => ({ suggestions: [{ id, suggestion: { type: 'idea', action: 'keep', reason: 'reason' } }] })
const pendingImage = (): Row => ({
  ...row('item'),
  kind: 'photo',
  text: '',
  recognized: '',
  assetId: 'image',
  recognitionStatus: 'pending'
})
describe('review round1 candidate and OCR regressions', () => {
  it('filters eligibility before choosing three distinct notes from mixed fragments', async () => {
    state.invalidNotes.add('free-1')
    state.invalidNotes.add('free-2')
    state.similar.mockResolvedValue(
      ['free-1', 'free-2', 'note-1', 'note-1', 'note-2', 'note-3'].map((parentId) => ({
        parentType: 'note',
        parentId,
        title: parentId,
        sim: 0.8
      }))
    )
    state.structured.mockImplementation(async ({ prompt }) => {
      const input = JSON.parse(prompt) as { items: { candidates: { id: string }[] }[] }
      expect(input.items[0].candidates.map((c) => c.id)).toEqual(['note-1', 'note-2', 'note-3'])
      return output()
    })
    await triage()
  })
  it('does not call the model with pending image recognition, then triages completed OCR', async () => {
    state.rows = [pendingImage()]
    state.structured.mockResolvedValue(output())
    expect(await triage()).toBe(0)
    expect(state.structured).not.toHaveBeenCalled()
    registerInboxJobs()
    await state.jobs.get('inbox.recognize')!.run({ id: 'item' }, context())
    expect(state.rows[0].status).toBe('new')
    expect(await triage()).toBe(1)
    expect(state.structured.mock.calls[0][0].prompt).toContain('新识别原文')
  })
  it('invalidates legacy stale suggested content when OCR finishes after a previous model result', async () => {
    state.rows = [{ ...pendingImage(), status: 'suggested', suggestion: JSON.stringify(output().suggestions[0].suggestion) }]
    registerInboxJobs()
    await state.jobs.get('inbox.recognize')!.run({ id: 'item' }, context())
    expect(state.rows[0].status).toBe('new')
    expect(state.rows[0].suggestion).toBeNull()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
describe('review round1 OCR ordering and persisted daily continuation', () => {
  it('drops an in-flight old model result when OCR completes first, then uses the new recognized text', async () => {
    state.rows = [{ ...pendingImage(), recognitionStatus: 'unavailable' }]
    const model = deferred<unknown>()
    const entered = deferred<void>()
    state.structured
      .mockImplementationOnce(() => {
        entered.resolve()
        return model.promise
      })
      .mockResolvedValue(output())
    const organizing = triage()
    await entered.promise
    registerInboxJobs()
    await state.jobs.get('inbox.recognize')!.run({ id: 'item' }, context())
    model.resolve(output())
    expect(await organizing).toBe(0)
    expect(state.rows[0].status).toBe('new')
    expect(await triage()).toBe(1)
    expect(state.structured.mock.calls[1][0].prompt).toContain('新识别原文')
  })
  it('invalidates a model result that finishes before later recognition starts', async () => {
    state.rows = [{ ...pendingImage(), recognitionStatus: 'unavailable' }]
    state.structured.mockResolvedValue(output())
    expect(await triage()).toBe(1)
    expect(state.rows[0].status).toBe('suggested')
    registerInboxJobs()
    const ocr = deferred<{ text: string; blocks: never[]; engine: string }>()
    state.recognize.mockReturnValueOnce(ocr.promise)
    const recognizing = state.jobs.get('inbox.recognize')!.run({ id: 'item' }, context())
    expect(state.rows[0].status).toBe('new')
    expect(state.rows[0].suggestion).toBeNull()
    expect(await triage()).toBe(0)
    ocr.resolve({ text: '迟到的识别材料', blocks: [], engine: 'test' })
    await recognizing
    expect(await triage()).toBe(1)
    expect(state.structured.mock.calls[1][0].prompt).toContain('迟到的识别材料')
  })
  it('persists a deferred selection across job registration/restart after the daily day was consumed', async () => {
    state.rows = [pendingImage()]
    state.meta = '2026-10-09'
    state.installed = true
    state.structured.mockResolvedValue(output())
    registerInboxJobs()
    state.enqueue.mockClear()
    await state.jobs.get('inbox.triage')!.run({}, context())
    expect(state.structured).not.toHaveBeenCalled()
    const [kind, payload, options] = state.enqueue.mock.calls[0] as [string, { ids: string[] }, { runAfter: number; dedupeKey: string }]
    expect(kind).toBe('inbox.triage')
    expect(payload.ids).toEqual(['item'])
    expect(options.runAfter).toBeGreaterThan(Date.now())
    // 重建注册表模拟进程恢复，延后任务使用其持久 payload，不依赖重新消耗当日调度键。
    state.jobs.clear()
    registerInboxJobs()
    await state.jobs.get('inbox.recognize')!.run({ id: 'item' }, context())
    state.enqueue.mockClear()
    await state.jobs.get(kind)!.run(payload, context())
    expect(state.rows[0].status).toBe('suggested')
    expect(state.structured.mock.calls[0][0].prompt).toContain('新识别原文')
    expect(state.enqueue).not.toHaveBeenCalled()
  })
  it('requeues OCR that finishes during a daily model batch and cancels deferred jobs without resurrection', async () => {
    state.rows = [row('text'), pendingImage()]
    registerInboxJobs()
    state.structured.mockImplementationOnce(async () => {
      await state.jobs.get('inbox.recognize')!.run({ id: 'item' }, context())
      return output('text')
    })
    await state.jobs.get('inbox.triage')!.run({}, context())
    const payload = state.enqueue.mock.calls[0][1] as { ids: string[] }
    expect(payload.ids).toEqual(['item'])
    state.enqueue.mockClear()
    state.structured.mockClear()
    await state.jobs.get('inbox.triage')!.run(
      payload,
      context(() => true)
    )
    expect(state.enqueue).not.toHaveBeenCalled()
    expect(state.structured).not.toHaveBeenCalled()
    expect(state.rows[1].status).toBe('new')
  })
  it('retains delayed work if the model is removed, and disabled daily scheduling stops the continuation', async () => {
    state.rows = [pendingImage()]
    state.settings.ai.chat.model = null
    registerInboxJobs()
    await state.jobs.get('inbox.triage')!.run({ ids: ['item'] }, context())
    expect(state.enqueue).toHaveBeenCalledWith('inbox.triage', { ids: ['item'] }, expect.objectContaining({ runAfter: expect.any(Number) }))
    state.enqueue.mockClear()
    state.settings.capture.daily = false
    await state.jobs.get('inbox.triage')!.run({ ids: ['item'] }, context())
    expect(state.enqueue).not.toHaveBeenCalled()
  })
})

describe('review round1 overlapping requests', () => {
  it('does not drop a ready OCR continuation while a different manual selection is in flight', async () => {
    state.rows = [row('first'), { ...pendingImage(), recognized: '已经识别的续跑材料', recognitionStatus: 'ready' }]
    const firstModel = deferred<unknown>(),
      entered = deferred<void>()
    state.structured
      .mockImplementationOnce(() => {
        entered.resolve()
        return firstModel.promise
      })
      .mockImplementationOnce(async ({ prompt }) => {
        expect(prompt).toContain('已经识别的续跑材料')
        return output('item')
      })
    const first = triage(['first'])
    await entered.promise
    const second = triage(['item'])
    firstModel.resolve(output('first'))
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(state.rows.every((r) => r.status === 'suggested')).toBe(true)
    expect(state.structured).toHaveBeenCalledTimes(2)
  })
})

it('keeps OCR continuations in the selected DeepSeek off-peak window after a delayed restart', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-09T02:00:00Z'))
  try {
    state.settings.capture.offPeak = true
    registerInboxJobs()
    await state.jobs.get('inbox.triage')!.run({ ids: ['item'] }, context())
    expect(state.structured).not.toHaveBeenCalled()
    expect(state.enqueue).toHaveBeenCalledWith(
      'inbox.triage',
      { ids: ['item'] },
      expect.objectContaining({ runAfter: Date.parse('2026-10-09T04:00:00Z') })
    )
  } finally {
    clock.mockRestore()
  }
})

describe('review round2 recognition cancellation terminal state', () => {
  it('cancels queued recognition without running OCR, keeps originals and allows manual triage without daily waiting', async () => {
    state.rows = [{ ...pendingImage(), text: '用户已有的文字', recognized: '已有识别文字' }]
    registerInboxJobs()
    state.jobs.get('inbox.recognize')!.onCancel?.({ id: 'item' })
    expect(state.rows[0].recognitionStatus).toBe('canceled')
    expect(state.rows[0]).toMatchObject({ assetId: 'image', text: '用户已有的文字', recognized: '已有识别文字' })
    expect(state.recognize).not.toHaveBeenCalled()
    state.structured.mockResolvedValue(output())
    expect(await triage()).toBe(1)
    expect(state.structured.mock.calls[0][0].prompt).toContain('已有识别文字')
    state.rows[0].status = 'new'
    state.rows[0].suggestion = null
    state.enqueue.mockClear()
    await state.jobs.get('inbox.triage')!.run({ ids: ['item'] }, context())
    expect(state.rows[0].status).toBe('suggested')
    expect(state.enqueue).not.toHaveBeenCalled()
    state.installed = true
    registerInboxJobs()
    expect(state.enqueue).not.toHaveBeenCalled()
  })
  it('cancels running OCR immediately and ignores its late result after an explicit newer attempt', async () => {
    state.rows = [{ ...pendingImage(), text: '保留这条原文' }]
    registerInboxJobs()
    const old = deferred<{ text: string; blocks: never[]; engine: string }>()
    state.recognize.mockReturnValueOnce(old.promise)
    let canceled = false
    const work = state.jobs.get('inbox.recognize')!.run(
      { id: 'item' },
      context(() => canceled)
    )
    canceled = true
    state.jobs.get('inbox.recognize')!.onCancel?.({ id: 'item' })
    expect(state.rows[0].recognitionStatus).toBe('canceled')
    state.jobs.get('inbox.recognize')!.onRetry?.({ id: 'item' })
    expect(state.rows[0].recognitionStatus).toBe('pending')
    await state.jobs.get('inbox.recognize')!.run({ id: 'item' }, context())
    expect(state.rows[0]).toMatchObject({ recognitionStatus: 'ready', recognized: '新识别原文' })
    old.resolve({ text: '不应覆盖的新旧乱序结果', blocks: [], engine: 'old' })
    await work
    expect(state.rows[0]).toMatchObject({ recognitionStatus: 'ready', recognized: '新识别原文', text: '保留这条原文', assetId: 'image' })
  })
})

describe('final review localized main-process delivery', () => {
  it.each([
    ['zh-CN', '请选择允许提案的有效康奈尔笔记', '来自收件箱', '收件箱整理好了', '条新建议'],
    ['en', 'Choose an active Cornell note that permits proposals', 'From inbox', 'Inbox organized', 'new suggestions']
  ])('uses %s resources for recoverable errors, sources and notifications', async (language, error, source, title, body) => {
    state.settings.language = language
    state.invalidNotes.add('invalid')
    await expect(accept('item', { action: 'append_note', noteId: 'invalid' })).rejects.toThrow(error)
    const { createProposal } = await import('../../services/proposals')
    vi.mocked(createProposal).mockReturnValue({ id: 'proposal' } as ReturnType<typeof createProposal>)
    await accept('item', { action: 'append_note', noteId: 'valid' })
    expect(JSON.stringify(vi.mocked(createProposal).mock.lastCall)).toContain(source)
    state.rows = [row('notification')]
    state.structured.mockResolvedValue(output('notification'))
    registerInboxJobs()
    await state.jobs.get('inbox.triage')!.run({}, context())
    expect(state.notification).toHaveBeenLastCalledWith({ title, body: expect.stringContaining(body) })
    state.settings.language = 'zh-CN'
  })
})

describe('item-based recognition retry', () => {
  it('invalidates stale suggestions at explicit retry while preserving original text and image', () => {
    state.rows = [
      {
        ...pendingImage(),
        text: '用户原文',
        recognized: '已有文字',
        recognitionStatus: 'canceled',
        status: 'suggested',
        suggestion: JSON.stringify(output().suggestions[0].suggestion)
      }
    ]
    expect(retryRecognition('item')).toBe('attempt')
    expect(state.rows[0]).toMatchObject({
      text: '用户原文',
      recognized: '已有文字',
      assetId: 'image',
      recognitionStatus: 'pending',
      status: 'new',
      suggestion: null
    })
    expect(state.retryOrEnqueue).toHaveBeenCalledWith('inbox.recognize', { id: 'item' }, 'inbox.recognize:item')
  })
  it('rejects deleted or missing originals through both item and task-panel retry', () => {
    registerInboxJobs()
    for (const deleted of [true, false]) {
      state.rows = [{ ...pendingImage(), recognitionStatus: 'canceled', deletedAt: deleted ? Date.now() : null }]
      state.originalExists = deleted
      expect(() => retryRecognition('item')).toThrow('原图片不存在或条目已删除')
      expect(() => state.jobs.get('inbox.recognize')!.onRetry?.({ id: 'item' })).toThrow('原图片不存在或条目已删除')
      expect(state.rows[0].recognitionStatus).toBe('canceled')
    }
    expect(state.retryOrEnqueue).not.toHaveBeenCalled()
  })
})

function directStep<T>(_key: string, _sourceId: string | null, fn: () => Promise<T>): Promise<T> {
  return fn()
}
