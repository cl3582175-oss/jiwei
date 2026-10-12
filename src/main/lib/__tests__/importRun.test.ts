import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { JobContext, JobKind } from '../../services/jobs'
import type { DocJSON } from '@shared/types'
import type { RunRecord, ItemRecord } from '../../services/importer/records'
import { importMarkdown } from '../importMarkdown'
import { scanLibrary } from '../../services/importer/scan'

const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  notes: new Map<string, { id: string; title: string; deletedAt: number | null; doc?: DocJSON }>(),
  history: [] as { rootHash: string; path: string; hash: string; noteId: string }[],
  handlers: new Map<string, JobKind<{ id: string }>>(),
  seq: 0
}))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, dialog: {} }))
vi.mock('../../db', () => ({ getDb: () => ({ transaction: (fn: () => unknown) => fn() }) }))
vi.mock('../ids', () => ({ newId: () => `reserved-${++state.seq}` }))
vi.mock('../../services/jobs', () => ({
  registerJobKind: (kind: string, handler: JobKind<{ id: string }>) => state.handlers.set(kind, handler),
  enqueue: () => 'job',
  cancelJob: vi.fn(),
  runInWorker: vi.fn()
}))
vi.mock('../../services/importer/records', () => ({
  readRecord: (key: string) => structuredClone(state.records.get(key) ?? null),
  saveRecord: (key: string, value: unknown) => state.records.set(key, structuredClone(value)),
  itemKey: (id: string, path: string) => `item.${id}.${path}`,
  items: (id: string) => [...state.records].filter(([key]) => key.startsWith(`item.${id}.`)).map(([, v]) => structuredClone(v)),
  importHistory: () => state.history,
  getRun: vi.fn(),
  listRuns: vi.fn()
}))
vi.mock('../../services/notes', () => ({
  getNote: (id: string) => state.notes.get(id) ?? null,
  createNote: (init: { id?: string; title: string }) => {
    const note = { id: init.id ?? `note-${++state.seq}`, title: init.title, deletedAt: null }
    state.notes.set(note.id, note)
    return note
  },
  trashNote: (id: string) => {
    const note = state.notes.get(id)
    if (note) note.deletedAt = 1
  }
}))
vi.mock('../../services/categories', () => ({
  listCategories: () => [{ id: 'category', name: 'Import' }],
  createCategory: () => ({ id: 'category' })
}))
vi.mock('../../services/docs', () => ({
  replaceDoc: (id: string, doc: DocJSON) => {
    state.notes.get(id)!.doc = doc
  }
}))
vi.mock('../../services/tags', () => ({ ensureTag: () => ({ id: 'tag' }), setTags: vi.fn() }))
vi.mock('../../services/assets', () => ({ importBytes: vi.fn(), MIME: {} }))
vi.mock('../../services/sources', () => ({ importPaths: vi.fn(), trashSource: vi.fn() }))
vi.mock('../../services/connections', () => ({ relate: vi.fn() }))
vi.mock('../../events', () => ({ emit: vi.fn() }))
vi.mock('../../services/agent/audit', () => ({ audit: vi.fn() }))
vi.mock('../../services/importer/cues', () => ({ estimateCues: vi.fn(), enqueueCues: vi.fn() }))
import { registerImporterJobs } from '../../services/importer/run'
import { readRecord, saveRecord, itemKey } from '../../services/importer/records'

beforeEach(() => {
  state.records.clear()
  state.notes.clear()
  state.history = []
  state.handlers.clear()
  state.seq = 0
  registerImporterJobs()
})
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'jiwei-run-unit-'))
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content)
  const library = await scanLibrary([root], [], () => {})
  const record: RunRecord = {
    rootHash: library.rootHash,
    options: {
      paths: library.entries.map((e) => e.path),
      categoryId: 'category',
      newCategoryName: 'Import',
      preserveFolders: true,
      tags: false,
      aiExcluded: false,
      aiCues: false,
      importChanged: false
    },
    state: {
      id: 'run',
      scanId: 'scan',
      kind: 'markdown',
      label: 'Import',
      status: 'queued',
      jobId: 'job',
      progress: 0,
      sourceIds: [],
      assetIds: [],
      categoryIds: [],
      cueJobIds: [],
      issues: [],
      tasks: 0,
      createdAt: 1
    }
  }
  saveRecord('scan.scan', { library, state: { status: 'ready' } })
  saveRecord('run.run', record)
  return { library, close: () => rm(root, { recursive: true, force: true }) }
}
function context(block?: { at: number; entered: () => void; resume: Promise<void> }): JobContext {
  let count = 0
  return {
    progress: vi.fn(),
    isCanceled: () => false,
    worker: async <T>(_task: string, payload: unknown): Promise<T> => {
      if (++count === block?.at) {
        block.entered()
        await block.resume
      }
      const p = payload as { text: string; filename: string }
      return importMarkdown(p.text, p.filename) as T
    }
  }
}
it('does not expose any editable note until its body is ready', async () => {
  const f = await fixture({ 'A.md': '# A\nOriginal A', 'B.md': '# B\nOriginal B' })
  let enter!: () => void, resume!: () => void
  const entered = new Promise<void>((r) => {
      enter = r
    }),
    gate = new Promise<void>((r) => {
      resume = r
    })
  const running = state.handlers.get('import.run')!.run({ id: 'run' }, context({ at: 3, entered: enter, resume: gate }))
  try {
    await entered
    expect(state.notes.size).toBe(0)
  } finally {
    resume()
    await running
    await f.close()
  }
  expect([...state.notes.values()].every((n) => JSON.stringify(n.doc).includes(`Original ${n.title}`))).toBe(true)
})
it('rebuilds links to unchanged skipped notes after restart without taking ownership of the old note', async () => {
  const f = await fixture({ 'A.md': '# A\nAlready imported', 'B.md': '# B\n[[A]]' })
  const entry = f.library.entries.find((e) => e.path === 'A.md')!
  state.notes.set('old-A', { id: 'old-A', title: 'A', deletedAt: null })
  state.history.push({ rootHash: f.library.rootHash, path: entry.path, hash: entry.hash, noteId: 'old-A' })
  saveRecord(itemKey('run', entry.path), {
    path: entry.path,
    rootHash: f.library.rootHash,
    hash: entry.hash,
    complete: true,
    status: 'skipped',
    message: 'unchanged'
  } satisfies ItemRecord)
  try {
    await state.handlers.get('import.run')!.run({ id: 'run' }, context())
    const doc = [...state.notes.values()].find((n) => n.title === 'B')!.doc
    expect(JSON.stringify(doc)).toContain('jiwei://note/old-A')
    expect(readRecord<ItemRecord>(itemKey('run', 'A.md'))?.noteId).toBeUndefined()
  } finally {
    await f.close()
  }
})
it('keeps checkpoints on system interruption and resumes', async () => {
  const f = await fixture({ 'A.md': '# A\nOriginal A' })
  let interrupted = false
  const ctx = context(),
    abort = new AbortController()
  const originalWorker = ctx.worker
  ctx.signal = abort.signal
  ctx.isCanceled = () => interrupted
  Object.assign(ctx, { isInterrupted: () => interrupted })
  let calls = 0
  ctx.worker = async (...args) => {
    if (++calls === 2) {
      interrupted = true
      abort.abort()
      throw new Error('Worker exited')
    }
    return originalWorker(...args)
  }
  try {
    await state.handlers.get('import.run')!.run({ id: 'run' }, ctx)
    expect(readRecord<RunRecord>('run.run')?.state.status).toBe('queued')
    await state.handlers.get('import.run')!.run({ id: 'run' }, context())
    expect(readRecord<RunRecord>('run.run')?.state.status).toBe('done')
    expect([...state.notes.values()].filter((n) => !n.deletedAt)).toHaveLength(1)
  } finally {
    await f.close()
  }
})

it('leaves explicit user cancellation terminal and does not create pending notes on retry', async () => {
  const f = await fixture({ 'A.md': '# A\nOriginal A' })
  let canceled = false
  const ctx = context(),
    originalWorker = ctx.worker
  ctx.isCanceled = () => canceled
  let calls = 0
  ctx.worker = async (...args) => {
    if (++calls === 2) {
      canceled = true
      throw new Error('Canceled by user')
    }
    return originalWorker(...args)
  }
  try {
    await state.handlers.get('import.run')!.run({ id: 'run' }, ctx)
    expect(readRecord<RunRecord>('run.run')?.state.status).toBe('canceled')
    expect(state.notes.size).toBe(0)
    await state.handlers.get('import.run')!.run({ id: 'run' }, context())
    expect(state.notes.size).toBe(0)
  } finally {
    await f.close()
  }
})
