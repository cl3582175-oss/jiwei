import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const f = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  db: null as ReturnType<typeof drizzle> | null,
  directory: '',
  pick: [] as string[],
  afterImport: null as (() => Promise<void>) | null,
  events: [] as string[],
  queuedWithoutProject: false,
  settings: { language: 'zh-CN', ai: { embedding: { mode: 'local' } } }
}))
vi.mock('../../../db', () => ({
  getDb: () => f.db,
  getSqlite: () => f.sql,
  dataDir: () => f.directory,
  assetsDir: () => join(f.directory, 'assets')
}))
vi.mock('../../../events', () => ({
  emit: (event: string) => {
    f.events.push(event)
    if (event === 'jobs:changed') {
      const bad = f.sql
        ?.prepare(
          "SELECT 1 FROM jobs j JOIN sources s ON json_extract(j.payload,'$.sourceId')=s.id WHERE s.space='attachment' AND NOT EXISTS(SELECT 1 FROM project_sources p WHERE p.item_type='source' AND p.item_id=s.id)"
        )
        .get()
      if (bad) f.queuedWithoutProject = true
    }
  },
  onMainEvent: () => () => {}
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => f.directory, getLocale: () => 'zh-CN', isPackaged: false },
  dialog: { showOpenDialog: async () => ({ canceled: !f.pick.length, filePaths: f.pick }) },
  shell: {},
  nativeImage: {},
  net: {},
  protocol: {},
  BrowserWindow: {}
}))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('../../device', () => ({ deviceId: () => 'controlled-device' }))
vi.mock('../../settings', () => ({ getSettings: () => f.settings }))
vi.mock('../../recording', () => ({
  recordingForSource: () => null,
  recordingAudio: () => null,
  purgeRecording: async () => {},
  restoreRecording: () => {}
}))
vi.mock('../../recordingFiles', () => ({ recordingKey: () => null, recordingPlainSize: () => 0, recordingStream: () => null }))
vi.mock('../../recognize', () => ({
  recognizingSources: () => [],
  IMAGE_EXTS: new Set(['png', 'jpg']),
  maybeAutoRecognize: () => {},
  applyRecognized: () => {},
  recordPages: () => {},
  wakeWaitingDigests: () => {},
  sourceRecognition: () => ({ engine: 'off', running: false })
}))
vi.mock('../../asr', () => ({
  isMedia: () => false,
  canAutoTranscribe: () => false,
  findSidecarSubtitles: () => null,
  enqueueTranscribe: () => {},
  applySubtitleFile: () => {}
}))
vi.mock('../../moss', () => ({ mossStatus: () => ({ state: 'missing' }), enqueueMoss: () => {} }))
vi.mock('../embedding', () => ({
  isReady: async () => false,
  currentModelId: () => 'controlled',
  getStatus: () => ({ state: 'missing' }),
  setStatus: () => {}
}))
vi.mock('../../recognizeRuntimes', () => ({}))
vi.mock('../../assets', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../assets')>()
  return {
    ...original,
    importFile: async (...args: Parameters<typeof original.importFile>) => {
      const result = await original.importFile(...args)
      await f.afterImport?.()
      return result
    }
  }
})

import { closeProfileDb } from '../../../db/profile'
import * as projects from '../projects'
import {
  addAttachments,
  attachmentStatus,
  bindAttachments,
  cleanupDrafts,
  detachConversationAttachments,
  listAttachmentSpace
} from '../../attachments'
import { getSource, importPaths, listSources, purgeSourceData, saveWebPage } from '../../sources'
import { listSegments } from '../../segments'
import { projectReadinessMany, readinessMany } from '../../readiness'
import { setMessageLanguage } from '../../../lib/messages'
import { assetPath } from '../../assets'
import { canReadSource } from '../../attachmentsAccess'
import { enqueueSegment } from '../../segmentJobs'
import { setOffPeakPolicy } from '../../jobs'

beforeEach(() => {
  vi.useFakeTimers()
  f.directory = mkdtempSync(join(tmpdir(), 'jiwei-project-sources-'))
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  for (const file of readdirSync(join(process.cwd(), 'resources/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    f.sql.exec(readFileSync(join(process.cwd(), 'resources/migrations', file), 'utf8'))
  }
  f.db = drizzle(f.sql)
  f.pick = []
  f.afterImport = null
  f.events = []
  f.queuedWithoutProject = false
  setMessageLanguage('zh-CN')
  for (const [id, incognito] of [
    ['ordinary', 0],
    ['same-project', 0],
    ['private', 1]
  ] as const) {
    f.sql.prepare('INSERT INTO conversations(id,title,incognito,created_at,updated_at) VALUES(?,?,?,1,1)').run(id, id, incognito)
  }
})
afterEach(() => {
  setOffPeakPolicy(null)
  vi.clearAllTimers()
  vi.useRealTimers()
  closeProfileDb()
  f.sql?.close()
  rmSync(f.directory, { recursive: true, force: true })
})
function project(name: string) {
  return projects.createProject({ name, instructions: '', memory: 'default', libraryScope: 'all' })
}
function file(name: string, text = 'Synthetic project source evidence'): string {
  const path = join(f.directory, name)
  writeFileSync(path, text)
  return path
}
const sourceRows = () => f.sql!.prepare('SELECT id,space,ai_excluded,deleted_at FROM sources').all()

it('promotes an already queued automatic upgrade when the project explicitly reprocesses its source', async () => {
  const a = project('A')
  const [item] = await projects.addProjectSources(a.id, { origin: 'upload', paths: [file('scan.pdf')] })
  f.sql!.exec('DELETE FROM jobs')
  setOffPeakPolicy((at) => at + 60000)
  enqueueSegment(item.itemId, { upgrade: true, offPeak: true })
  const before = f.sql!.prepare('SELECT id,run_after FROM jobs').get() as { id: string; run_after: number }
  expect(before.run_after).toBeGreaterThan(Date.now())
  projects.reprocessProjectSource(a.id, item.itemId)
  const after = f.sql!.prepare('SELECT id,payload,run_after FROM jobs').all() as { id: string; payload: string; run_after: number }[]
  expect(after).toHaveLength(1)
  expect(after[0].id).toBe(before.id)
  expect(JSON.parse(after[0].payload)).toMatchObject({ sourceId: item.itemId, upgrade: false })
  expect(after[0].run_after).toBeLessThanOrEqual(Date.now())
  f.sql!.prepare("UPDATE jobs SET status='running',payload=? WHERE id=?").run(
    JSON.stringify({ sourceId: item.itemId, upgrade: true }),
    before.id
  )
  projects.reprocessProjectSource(a.id, item.itemId)
  const running = f.sql!.prepare("SELECT payload FROM jobs WHERE status='running'").get() as { payload: string }
  expect(JSON.parse(running.payload).upgrade).toBe(true)
  expect(f.sql!.prepare("SELECT count(*) n FROM jobs WHERE status='queued'").get()).toEqual({ n: 1 })
})

it('reprocesses an existing owned PDF on the same source id and preserves OCR identity', async () => {
  const a = project('A'),
    b = project('B')
  const [item] = await projects.addProjectSources(a.id, { origin: 'upload', paths: [file('scan.pdf')] })
  f.sql!.exec('DELETE FROM jobs')
  f.sql!.prepare(
    "INSERT INTO source_pages(source_id,page,need,status,text,updated_at) VALUES(?,1,'scan','done','Previously recognized',1)"
  ).run(item.itemId)
  projects.reprocessProjectSource(a.id, item.itemId)
  const queued = f.sql!.prepare("SELECT payload FROM jobs WHERE kind='source.segment'").all() as { payload: string }[]
  expect(queued.map((j) => JSON.parse(j.payload).sourceId)).toEqual([item.itemId])
  expect(f.sql!.prepare('SELECT status,text FROM source_pages WHERE source_id=?').get(item.itemId)).toEqual({
    status: 'done',
    text: 'Previously recognized'
  })
  expect(sourceRows()).toContainEqual(expect.objectContaining({ id: item.itemId, space: 'attachment', ai_excluded: 1 }))
  expect(() => projects.reprocessProjectSource(b.id, item.itemId)).toThrow()
  projects.removeProjectSource(a.id, 'source', item.itemId)
  expect(() => projects.reprocessProjectSource(a.id, item.itemId)).toThrow()
})

describe('project source storage and management', () => {
  it('uploads use separate identities for library, each project, and ordinary conversation while sharing asset bytes', async () => {
    const path = file('project-file.txt'),
      a = project('A'),
      b = project('B')
    const library = (await importPaths([path])).imported[0]
    const [first] = await projects.addProjectSources(a.id, { origin: 'upload', paths: [path] })
    const [again] = await projects.addProjectSources(a.id, { origin: 'upload', paths: [path] })
    const [other] = await projects.addProjectSources(b.id, { origin: 'upload', paths: [path] })
    const [ordinary] = await addAttachments({ paths: [path], conversationId: 'ordinary' })
    expect(first.itemId).toBe(again.itemId)
    expect(new Set([library.id, first.itemId, other.itemId]).size).toBe(3)
    expect(ordinary.sourceId).toBe(library.id)
    expect(getSource(first.itemId)).toMatchObject({ space: 'attachment', aiExcluded: true })
    expect(getSource(library.id)).toMatchObject({ space: 'library', aiExcluded: false })
    expect((f.sql!.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n).toBe(1)
    expect(f.queuedWithoutProject).toBe(false)
    expect(attachmentStatus([first.itemId])[0].projects).toEqual([{ id: a.id, name: 'A' }])
    expect(attachmentStatus([first.itemId])[0].conversations).toEqual([])
    expect(listAttachmentSpace({ state: 'unarchived' }).find((row) => row.sourceId === first.itemId)?.projects).toEqual([
      { id: a.id, name: 'A' }
    ])
  })

  it('supports the native picker and keeps uploaded parsing readiness on the established job path', async () => {
    const a = project('A')
    f.pick = [file('project-picked.txt')]
    const [source] = await projects.addProjectSources(a.id, { origin: 'upload' }, null)
    expect(source).toMatchObject({ origin: 'upload', available: true, readiness: { state: 'preparing', reason: 'parsing' } })
    expect(f.sql!.prepare("SELECT kind FROM jobs WHERE json_extract(payload,'$.sourceId')=?").get(source.itemId)).toEqual({
      kind: 'source.segment'
    })
  })

  it('returns no additions when the picker is canceled and surfaces unsupported files without inserting a placeholder source', async () => {
    const a = project('A')
    await projects.addProjectSources(a.id, { origin: 'text', title: 'Existing', text: 'Existing private content' })
    expect(await projects.addProjectSources(a.id, { origin: 'upload' }, null)).toEqual([])
    setMessageLanguage('en')
    await expect(projects.addProjectSources(a.id, { origin: 'upload', paths: [file('unsupported.exe')] })).rejects.toThrow(
      'Unsupported format'
    )
    expect(projects.projectSourceList(a.id)).toHaveLength(1)
    expect(sourceRows()).toHaveLength(1)
  })

  it('pasted text writes actual segments privately and returns scoped readiness without forged conversation permission', async () => {
    const a = project('A'),
      b = project('B')
    const [source] = await projects.addProjectSources(a.id, {
      origin: 'text',
      title: 'Project memo',
      text: 'PRIVATE-TEXT-MARKER\n\nA second paragraph.'
    })
    expect(
      listSegments(source.itemId)
        .map((segment) => segment.text)
        .join('\n')
    ).toContain('PRIVATE-TEXT-MARKER')
    expect(source).toMatchObject({
      origin: 'text',
      title: 'Project memo',
      space: 'attachment',
      available: true,
      readiness: { state: 'ready' }
    })
    expect(projectReadinessMany(a.id, [source.itemId])[source.itemId]).toEqual({ state: 'ready' })
    expect(projectReadinessMany(b.id, [source.itemId])).toEqual({})
    expect(readinessMany([source.itemId])).toEqual({})
    expect(listSources({}).map((row) => row.id)).not.toContain(source.itemId)
  })

  it('URL insertion is private and related before the existing fetch job becomes visible', async () => {
    const a = project('A')
    const [source] = await projects.addProjectSources(a.id, { origin: 'url', url: 'https://example.test/project-url' })
    expect(source.readiness).toEqual({ state: 'preparing', reason: 'parsing' })
    expect(getSource(source.itemId)).toMatchObject({ space: 'attachment', aiExcluded: true, url: 'https://example.test/project-url' })
    expect(f.sql!.prepare("SELECT kind FROM jobs WHERE json_extract(payload,'$.sourceId')=?").get(source.itemId)).toEqual({
      kind: 'source.fetch'
    })
    expect(f.sql!.prepare('SELECT origin FROM project_sources WHERE project_id=? AND item_id=?').get(a.id, source.itemId)).toEqual({
      origin: 'url'
    })
    expect(f.queuedWithoutProject).toBe(false)
  })

  it('saving an ordinary browser page never reuses or updates a private project source with the same URL', async () => {
    const a = project('A'),
      url = 'https://example.test/same-url'
    const [privateSource] = await projects.addProjectSources(a.id, { origin: 'url', url })
    const saved = await saveWebPage({ url, title: 'Public saved page', html: '<p>User saved browser content</p>' })
    expect(saved.id).not.toBe(privateSource.itemId)
    expect(saved).toMatchObject({ space: 'library', aiExcluded: false })
    expect(getSource(privateSource.itemId)).toMatchObject({ space: 'attachment', aiExcluded: true, assetUrl: null })
  })

  it('library additions create references only, reject hidden or private material, and do not partially accept invalid batches', async () => {
    const a = project('A'),
      b = project('B')
    const library = (await importPaths([file('library.txt')])).imported[0]
    f.sql!.prepare("INSERT INTO notes(id,title,learned_at,edited_at,created_at,updated_at) VALUES('note','Library note',1,1,1,1)").run()
    const result = await projects.addProjectSources(a.id, { origin: 'library', notes: ['note'], sources: [library.id] })
    expect(result.map((row) => row.itemType).sort()).toEqual(['note', 'source'])
    expect(getSource(library.id)).toMatchObject({ space: 'library', aiExcluded: false })
    const [privateSource] = await projects.addProjectSources(b.id, { origin: 'text', title: 'Private', text: 'Private content' })
    await expect(projects.addProjectSources(a.id, { origin: 'library', notes: [], sources: [privateSource.itemId] })).rejects.toThrow()
    f.sql!.prepare('UPDATE sources SET ai_excluded=1 WHERE id=?').run(library.id)
    expect(projects.projectSourceList(a.id).find((row) => row.itemId === library.id)).toMatchObject({ available: false, readiness: null })
    await expect(projects.addProjectSources(b.id, { origin: 'library', notes: ['note'], sources: [library.id] })).rejects.toThrow()
    expect(projects.projectSourceList(b.id).map((row) => row.itemId)).toEqual([privateSource.itemId])
  })

  it('archive preserves the project relation and deletion trashes only private owned sources', async () => {
    const a = project('A')
    const [archived] = await projects.addProjectSources(a.id, { origin: 'text', title: 'Archived', text: 'Archive marker' })
    const [privateSource] = await projects.addProjectSources(a.id, { origin: 'text', title: 'Private', text: 'Keep private' })
    const library = (await importPaths([file('library.txt')])).imported[0]
    await projects.addProjectSources(a.id, { origin: 'library', notes: [], sources: [library.id] })
    projects.archiveProjectSource(a.id, archived.itemId, null)
    expect(projects.projectSourceList(a.id).find((row) => row.itemId === archived.itemId)).toMatchObject({
      origin: 'text',
      space: 'library'
    })
    expect(getSource(archived.itemId)).toMatchObject({ aiExcluded: false, space: 'library', deletedAt: null })
    await projects.removeProject(a.id, 'recent')
    expect(getSource(privateSource.itemId)?.deletedAt).not.toBeNull()
    expect(getSource(archived.itemId)?.deletedAt).toBeNull()
    expect(getSource(library.id)?.deletedAt).toBeNull()
    expect(f.sql!.prepare('SELECT * FROM project_sources').all()).toEqual([])
  })

  it('relation removal leaves the source private; draft cleanup and incognito detach preserve referenced project sources', async () => {
    const a = project('A')
    const [kept] = await projects.addProjectSources(a.id, { origin: 'text', title: 'Kept', text: 'Private old source' })
    f.sql!.prepare('UPDATE sources SET created_at=1 WHERE id=?').run(kept.itemId)
    await cleanupDrafts()
    expect(getSource(kept.itemId)).not.toBeNull()
    f.sql!.prepare("INSERT INTO conversation_attachments(conversation_id,source_id,created_at) VALUES('private',?,1)").run(kept.itemId)
    detachConversationAttachments('private')
    expect(getSource(kept.itemId)).not.toBeNull()
    projects.removeProjectSource(a.id, 'source', kept.itemId)
    expect(projects.projectSourceList(a.id)).toEqual([])
    expect(getSource(kept.itemId)).toMatchObject({ space: 'attachment', aiExcluded: true, deletedAt: null })
  })

  it('retains detached project sources and bytes after draft cleanup without granting any conversation access', async () => {
    const a = project('A'),
      marker = 'DETACHED-PROJECT-ORIGINAL-BYTES'
    f.sql!.prepare("UPDATE conversations SET project_id=? WHERE id='same-project'").run(a.id)
    const [source] = await projects.addProjectSources(a.id, { origin: 'upload', paths: [file('retained.txt', marker)] })
    const asset = f.sql!.prepare('SELECT asset_id FROM sources WHERE id=?').get(source.itemId) as { asset_id: string }
    f.sql!.prepare('UPDATE sources SET created_at=1 WHERE id=?').run(source.itemId)
    projects.removeProjectSource(a.id, 'source', source.itemId)
    projects.removeProjectSource(a.id, 'source', source.itemId)
    await cleanupDrafts()
    expect(getSource(source.itemId)).toMatchObject({ space: 'attachment', aiExcluded: true, deletedAt: null })
    expect(readFileSync(assetPath(asset.asset_id, 'txt'), 'utf8')).toBe(marker)
    expect(f.sql!.prepare('SELECT conversation_id FROM conversation_attachments WHERE source_id=?').all(source.itemId)).toEqual([
      { conversation_id: `orphan:project:${a.id}` }
    ])
    expect(f.sql!.prepare("SELECT id FROM conversations WHERE id LIKE 'orphan:%'").all()).toEqual([])
    for (const chat of [null, 'same-project', 'ordinary', 'private']) expect(canReadSource(source.itemId, chat)).toBe(false)
    const [active] = await projects.addProjectSources(a.id, { origin: 'text', title: 'Still owned', text: 'Still project-private' })
    await projects.removeProject(a.id, 'recent')
    expect(getSource(active.itemId)?.deletedAt).not.toBeNull()
    expect(getSource(source.itemId)).toMatchObject({ deletedAt: null, space: 'attachment', aiExcluded: true })
    await cleanupDrafts()
    expect(readFileSync(assetPath(asset.asset_id, 'txt'), 'utf8')).toBe(marker)
  })

  it('private project identities cannot become conversation attachments; ordinary upload gets a separate identity', async () => {
    const a = project('A'),
      path = file('project-only.txt')
    f.sql!.prepare("UPDATE conversations SET project_id=? WHERE id='same-project'").run(a.id)
    const [privateSource] = await projects.addProjectSources(a.id, { origin: 'upload', paths: [path] })
    expect(() => bindAttachments('same-project', [privateSource.itemId], null)).toThrow()
    expect(() => bindAttachments('ordinary', [privateSource.itemId], null)).toThrow()
    const [ordinary] = await addAttachments({ paths: [path], conversationId: 'ordinary' })
    expect(ordinary.sourceId).not.toBe(privateSource.itemId)
    expect(f.sql!.prepare('SELECT source_id FROM conversation_attachments').all()).toEqual([{ source_id: ordinary.sourceId }])
  })

  it('permanent source purge removes stale project references', async () => {
    const a = project('A')
    const [source] = await projects.addProjectSources(a.id, { origin: 'text', title: 'Purge', text: 'Synthetic purge candidate' })
    purgeSourceData(source.itemId)
    expect(projects.projectSourceList(a.id)).toEqual([])
  })

  it('rejects deletion during file import before creating a source identity or project relationship', async () => {
    const a = project('A'),
      path = file('project-race.txt')
    f.afterImport = async () => {
      await projects.removeProject(a.id, 'recent')
    }
    await expect(projects.addProjectSources(a.id, { origin: 'upload', paths: [path] })).rejects.toThrow()
    expect(sourceRows()).toEqual([])
    expect(f.sql!.prepare('SELECT * FROM project_sources').all()).toEqual([])
    expect(f.sql!.prepare('SELECT * FROM assets').all()).toEqual([])
  })

  it('a deletion between batch files revokes the earlier private source and prevents creating the next one', async () => {
    const a = project('A'),
      first = file('project-first.txt', 'First synthetic bytes'),
      second = file('project-second.txt', 'Second synthetic bytes')
    let imported = 0
    f.afterImport = async () => {
      if (++imported === 2) await projects.removeProject(a.id, 'recent')
    }
    await expect(projects.addProjectSources(a.id, { origin: 'upload', paths: [first, second] })).rejects.toThrow()
    expect(sourceRows()).toHaveLength(1)
    expect(sourceRows()[0]).toMatchObject({ space: 'attachment', ai_excluded: 1, deleted_at: expect.any(Number) })
    expect(f.sql!.prepare('SELECT * FROM project_sources').all()).toEqual([])
  })

  it('management failures are bilingual and deleted projects cannot expose readiness', async () => {
    const a = project('A')
    await projects.removeProject(a.id, 'recent')
    setMessageLanguage('en')
    expect(() => projectReadinessMany(a.id, ['missing'])).toThrow('Project not found')
    await expect(projects.addProjectSources(a.id, { origin: 'text', title: 'Invalid', text: 'Never inserted' })).rejects.toThrow(
      'Project not found'
    )
    expect(sourceRows()).toEqual([])
  })
})
