import { app, dialog, type BrowserWindow } from 'electron'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, posix, basename } from 'path'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb, getSqlite } from '../../db'
import { sources, assets } from '../../db/schema'
import { newId } from '../../lib/ids'
import { decodeImportText, type ConvertedMarkdown } from '../../lib/importMarkdown'
import { readChecked, matchAttachment, type ScannedLibrary } from './scan'
import { matchNote } from './obsidian'
import {
  readRecord,
  saveRecord,
  getRun,
  listRuns,
  importHistory,
  items,
  itemKey,
  type ScanRecord,
  type RunRecord,
  type ItemRecord
} from './records'
import { enqueue, registerJobKind, cancelJob, runInWorker, type JobContext } from '../jobs'
import { createNote, getNote, trashNote } from '../notes'
import { createCategory, listCategories } from '../categories'
import { replaceDoc } from '../docs'
import { ensureTag, setTags } from '../tags'
import { importBytes, MIME } from '../assets'
import { importPaths, trashSource } from '../sources'
import { relate } from '../connections'
import { emit } from '../../events'
import { audit } from '../agent/audit'
import { estimateCues, enqueueCues } from './cues'
import { ImportOptionsSchema, type ImportOptions, type ImportPreview, type ImportRun, type ImportScan } from '@shared/importer'
import type { DocNode } from '@shared/types'

export { getRun, listRuns }
const SCAN = 'import.scan',
  RUN = 'import.run'
const publish = (): void => emit('importer:changed', {})
export function getScan(id: string): ImportScan {
  const row = readRecord<ScanRecord>(`scan.${id}`)
  if (!row) throw new Error('Import scan not found')
  return row.state
}
export function beginScan(paths: string[]): ImportScan {
  const id = newId()
  const state: ImportScan = {
    id,
    kind: 'markdown',
    label: basename(paths[0]),
    status: 'queued',
    jobId: '',
    progress: 0,
    entries: [],
    issues: [],
    stats: { notes: 0, attachments: 0, tags: 0, links: 0, tasks: 0 }
  }
  getDb().transaction(() => {
    state.jobId = enqueue(SCAN, { id })
    saveRecord(`scan.${id}`, { state, paths } satisfies ScanRecord)
  })
  return state
}
export async function chooseLibrary(win: BrowserWindow | null, mode: 'folder' | 'files'): Promise<ImportScan | null> {
  const options: Electron.OpenDialogOptions = {
    properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
    ...(mode === 'files' ? { filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] } : {})
  }
  const result = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
  return result.canceled || !result.filePaths.length ? null : beginScan(result.filePaths)
}
function scanRecord(id: string): ScanRecord & { library: ScannedLibrary } {
  const row = readRecord<ScanRecord>(`scan.${id}`)
  if (!row?.library || row.state.status !== 'ready') throw new Error('Scan not ready')
  return row as ScanRecord & { library: ScannedLibrary }
}
async function conversion(library: ScannedLibrary, path: string, ctx?: JobContext): Promise<ConvertedMarkdown> {
  const file = library.files.find((f) => f.relative === path)
  if (!file) throw new Error('Unknown source')
  const input = { text: decodeImportText(await readChecked(library, file)).text, filename: path }
  return ctx ? ctx.worker<ConvertedMarkdown>('import.convert', input) : runInWorker<ConvertedMarkdown>('import.convert', input)
}
export async function preview(id: string, path: string): Promise<ImportPreview> {
  const { library } = scanRecord(id)
  const parsed = await conversion(library, path)
  // Resolving external files in the preview never adds assets or jobs to the knowledge base.
  const walk = async (node: DocNode): Promise<void> => {
    if (node.type === 'image' && typeof node.attrs?.importRef === 'number') {
      const ref = parsed.refs[node.attrs.importRef],
        file = matchAttachment(ref.target, path, library)
      if (file) {
        const ext = file.relative.split('.').at(-1)!.toLowerCase(),
          mime = MIME[ext]
        if (mime?.startsWith('image/') && mime !== 'image/svg+xml')
          node.attrs = { src: `data:${mime};base64,${Buffer.from(await readChecked(library, file)).toString('base64')}`, alt: ref.label }
      }
    }
    for (const c of node.content ?? []) await walk(c)
  }
  for (const n of parsed.doc.content ?? []) await walk(n)
  return { title: parsed.title, doc: parsed.doc, embeds: parsed.embeds }
}
export function estimate(id: string, paths: string[]) {
  const { library } = scanRecord(id)
  return estimateCues(library.entries.filter((e) => paths.includes(e.path) && e.status !== 'unchanged'))
}
export function beginImport(id: string, input: ImportOptions): ImportRun {
  const options = ImportOptionsSchema.parse(input),
    { library } = scanRecord(id)
  if (!options.paths.every((p) => library.entries.some((e) => e.path === p))) throw new Error('Unknown selection')
  if (options.categoryId && !listCategories('note').some((c) => c.id === options.categoryId)) throw new Error('Invalid category')
  if (options.aiCues && !estimate(id, options.paths).available) throw new Error('AI model unavailable')
  const runId = newId(),
    now = Date.now()
  const run: RunRecord = {
    options,
    rootHash: library.rootHash,
    state: {
      id: runId,
      scanId: id,
      kind: library.kind,
      label: library.label,
      jobId: '',
      status: 'queued',
      progress: 0,
      sourceIds: [],
      assetIds: [],
      categoryIds: [],
      cueJobIds: [],
      issues: [...library.issues],
      tasks: 0,
      createdAt: now
    }
  }
  getDb().transaction(() => {
    run.state.jobId = enqueue(RUN, { id: runId })
    saveRecord(`run.${runId}`, run)
  })
  return getRun(runId)
}
export function cancelScan(id: string): void {
  cancelJob(getScan(id).jobId)
}
export function cancelImport(id: string): void {
  cancelJob(getRun(id).jobId)
}
export function cancelCues(id: string): void {
  for (const jobId of getRun(id).cueJobIds) cancelJob(jobId)
}
export function undoImport(id: string): ImportRun {
  const run = readRecord<RunRecord>(`run.${id}`)
  if (!run) throw new Error('Import run not found')
  if (['running', 'queued', 'canceling'].includes(run.state.status) || active.has(id)) throw new Error('Cancel import and wait before undo')
  if (run.state.undoneAt) return getRun(id)
  getDb().transaction(() => {
    cancelCues(id)
    for (const item of items(id)) if (item.noteId && item.status === 'imported') trashNote(item.noteId)
    for (const sourceId of run.state.sourceIds) {
      // Preserve an attachment now used by another live note, including user-created links.
      const owned = new Set(items(id).flatMap((i) => (i.noteId ? [i.noteId] : [])))
      const used = getSqlite()
        .prepare(
          "SELECT from_id FROM links JOIN notes ON notes.id = links.from_id WHERE to_type='source' AND to_id=? AND links.deleted_at IS NULL AND notes.deleted_at IS NULL"
        )
        .all(sourceId) as { from_id: string }[]
      if (!used.some((u) => !owned.has(u.from_id))) trashSource(sourceId)
    }
    run.state.undoneAt = Date.now()
    saveRecord(`run.${id}`, run)
    audit({
      caller: 'user',
      tool: 'importer.undo',
      level: 'write',
      summary: `Undo import (${items(id).filter((i) => i.status === 'imported').length} notes)`,
      status: 'ok'
    })
  })
  publish()
  return getRun(id)
}

let serial: Promise<unknown> = Promise.resolve()
const active = new Set<string>()
async function importRun(id: string, ctx: JobContext): Promise<void> {
  const record = readRecord<RunRecord>(`run.${id}`)
  if (!record || record.state.status === 'canceled' || record.state.status === 'canceling' || record.state.undoneAt) return
  const { library } = scanRecord(record.state.scanId),
    options = record.options
  const update = (): void => {
    saveRecord(`run.${id}`, record)
    publish()
  }
  const guard = (): void => {
    if (ctx.isCanceled() || readRecord<RunRecord>(`run.${id}`)?.state.undoneAt) throw new Error('canceled')
    ctx.signal?.throwIfAborted()
  }
  record.state.status = 'running'
  update()
  const parsed = new Map<string, Pick<ConvertedMarkdown, 'title' | 'createdAt'>>(),
    noteIds = new Map<string, string>()
  const past = importHistory()
  for (const entry of library.entries) {
    if (!options.paths.includes(entry.path)) {
      if (entry.previousNoteId && getNote(entry.previousNoteId)?.deletedAt === null) noteIds.set(entry.path, entry.previousNoteId)
      continue
    }
    const saved = readRecord<ItemRecord>(itemKey(id, entry.path))
    if (saved?.complete) {
      if (saved.noteId && saved.status === 'imported') noteIds.set(entry.path, saved.noteId)
      continue
    }
    const existing = past.filter((h) => h.rootHash === library.rootHash && h.path === entry.path).at(-1)
    if (!saved?.noteId && (existing?.hash === entry.hash || (existing && !options.importChanged))) {
      saveRecord(itemKey(id, entry.path), {
        path: entry.path,
        rootHash: library.rootHash,
        hash: entry.hash,
        status: 'skipped',
        message: existing.hash === entry.hash ? 'unchanged' : 'changed',
        complete: true
      } satisfies ItemRecord)
      noteIds.set(entry.path, existing.noteId)
      continue
    }
    guard()
    try {
      const converted = await conversion(library, entry.path, ctx)
      parsed.set(entry.path, { title: converted.title, createdAt: converted.createdAt })
      guard()
    } catch (e) {
      if (ctx.isCanceled() || ctx.signal?.aborted) throw e
      if (saved?.noteId) trashNote(saved.noteId)
      saveRecord(itemKey(id, entry.path), {
        path: entry.path,
        rootHash: library.rootHash,
        hash: entry.hash,
        status: 'failed',
        message: 'changed-or-unreadable',
        complete: true
      } satisfies ItemRecord)
    }
  }
  const folders = new Map<string, string>()
  const existingRoot = options.categoryId ?? record.state.categoryIds[0]
  if (existingRoot && listCategories('note').some((c) => c.id === existingRoot)) folders.set('', existingRoot)
  const category = (path: string): string | null => {
    if (!folders.has('')) {
      const root = options.categoryId ?? createCategory('note', options.newCategoryName).id
      folders.set('', root)
      if (!options.categoryId) record.state.categoryIds.push(root)
    }
    if (!options.preserveFolders) return folders.get('')!
    let key = '',
      parent = folders.get('')!
    for (const part of posix
      .dirname(path)
      .split('/')
      .filter((p) => p && p !== '.')) {
      key = key ? `${key}/${part}` : part
      if (!folders.has(key)) {
        const c = listCategories('note').find((c) => c.name === part && c.parentId === parent) ?? createCategory('note', part, parent)
        folders.set(key, c.id)
        if (!record.state.categoryIds.includes(c.id)) record.state.categoryIds.push(c.id)
      }
      parent = folders.get(key)!
    }
    return parent
  }
  for (const [path, converted] of parsed) {
    guard()
    getDb().transaction(() => {
      const saved = readRecord<ItemRecord>(itemKey(id, path))
      const noteId =
        saved?.noteId ??
        createNote({ title: converted.title, categoryId: category(path), aiExcluded: options.aiExcluded, createdAt: converted.createdAt })
          .id
      noteIds.set(path, noteId)
      saveRecord(itemKey(id, path), {
        path,
        rootHash: library.rootHash,
        hash: library.entries.find((e) => e.path === path)!.hash,
        noteId,
        status: 'imported',
        complete: false
      } satisfies ItemRecord)
      saveRecord(`run.${id}`, record)
    })
  }
  const cache = join(app.getPath('userData'), 'import-cache', id)
  try {
    for (const [path] of parsed) {
      guard()
      let converted: ConvertedMarkdown
      try {
        converted = await conversion(library, path, ctx)
        guard()
      } catch (e) {
        if (ctx.isCanceled() || ctx.signal?.aborted) throw e
        const item = readRecord<ItemRecord>(itemKey(id, path))!
        trashNote(item.noteId!)
        noteIds.delete(path)
        saveRecord(itemKey(id, path), { ...item, status: 'failed', message: 'changed-or-unreadable', complete: true })
        record.state.issues.push({ path, code: 'changed' })
        continue
      }
      const noteId = noteIds.get(path)!,
        sourceLinks = new Set<string>(),
        urls = new Map<number, string>()
      for (const [index, ref] of converted.refs.entries()) {
        guard()
        if (ref.kind === 'note') {
          const match = matchNote(ref.target, path, library.entries, ref.wiki),
            targetId = match ? noteIds.get(match.path) : undefined
          if (targetId) urls.set(index, `jiwei://note/${targetId}`)
          else if (match) record.state.issues.push({ path, code: 'excluded-target' })
          continue
        }
        const file = matchAttachment(ref.target, path, library)
        if (!file) continue
        try {
          const bytes = await readChecked(library, file)
          guard()
          const existed = !!getDb().select().from(assets).where(eq(assets.id, file.hash)).get()
          if (ref.kind === 'image') {
            const asset = await importBytes(file.relative, MIME[file.relative.split('.').at(-1)!] ?? 'application/octet-stream', bytes)
            if (!existed && !record.state.assetIds.includes(asset.id)) record.state.assetIds.push(asset.id)
            urls.set(index, asset.url)
            update()
            guard()
          } else {
            await mkdir(cache, { recursive: true })
            guard()
            const copy = join(cache, basename(file.relative))
            await writeFile(copy, bytes)
            guard()
            const imported = await importPaths([copy], null, {
              aiExcluded: options.aiExcluded,
              onCreated: (sourceId, assetId) => {
                if (!record.state.sourceIds.includes(sourceId)) record.state.sourceIds.push(sourceId)
                if (!existed && !record.state.assetIds.includes(assetId)) record.state.assetIds.push(assetId)
                saveRecord(`run.${id}`, record)
              }
            })
            let sourceId: string | undefined = imported.imported[0]?.id
            if (sourceId) {
              if (!record.state.sourceIds.includes(sourceId)) record.state.sourceIds.push(sourceId)
            } else
              sourceId = getDb()
                .select({ id: sources.id })
                .from(sources)
                .where(
                  and(
                    eq(sources.assetId, file.hash),
                    isNull(sources.deletedAt),
                    options.aiExcluded ? eq(sources.aiExcluded, true) : undefined
                  )
                )
                .get()?.id
            if (!existed && !record.state.assetIds.includes(file.hash)) record.state.assetIds.push(file.hash)
            if (sourceId) {
              urls.set(index, `jiwei://source/${sourceId}`)
              sourceLinks.add(sourceId)
            }
            update()
            guard()
          }
        } catch (e) {
          if (ctx.isCanceled() || ctx.signal?.aborted) throw e
          record.state.issues.push({ path: file.relative, code: 'changed' })
        }
      }
      const embeds: ConvertedMarkdown['embeds'] = {}
      const walk = (node: DocNode): DocNode => {
        const n: DocNode = { ...node }
        if (n.type === 'embed') {
          const old = String(n.attrs?.id),
            blockId = newId()
          embeds[blockId] = converted.embeds[old]
          n.attrs = { ...n.attrs, id: blockId }
        }
        if (n.type === 'image' && typeof n.attrs?.importRef === 'number') {
          const idx = n.attrs.importRef,
            src = urls.get(idx)
          if (!src) return { type: 'paragraph', content: [{ type: 'text', text: converted.refs[idx].label }] }
          n.attrs = { src, alt: converted.refs[idx].label }
        }
        n.marks = n.marks?.flatMap((m) => {
          const match = m.type === 'link' ? /^jiwei:\/\/import\/(\d+)$/.exec(String(m.attrs?.href)) : null
          if (!match) return [m]
          const href = urls.get(Number(match[1]))
          return href ? [{ type: 'link', attrs: { href } }] : []
        })
        if (n.content) n.content = n.content.map(walk)
        return n
      }
      guard()
      getDb().transaction(() => {
        replaceDoc(noteId, { ...converted.doc, content: converted.doc.content?.map(walk) }, embeds)
        if (options.tags)
          setTags(
            'note',
            noteId,
            converted.tags.map((tag) => ensureTag(tag).id)
          )
        for (const sourceId of sourceLinks) relate(noteId, 'source', sourceId)
        const item = readRecord<ItemRecord>(itemKey(id, path))!
        item.complete = true
        saveRecord(itemKey(id, path), item)
        record.state.tasks += converted.tasks
        record.state.progress = items(id).filter((i) => i.complete).length / options.paths.length
        saveRecord(`run.${id}`, record)
      })
      ctx.progress(record.state.progress)
      emit('notes:changed', { ids: [noteId] })
      publish()
      await new Promise<void>((done) => setImmediate(done))
    }
    guard()
    if (options.aiCues)
      for (const item of items(id))
        if (item.complete && item.status === 'imported' && item.noteId) record.state.cueJobIds.push(enqueueCues(id, item.noteId))
    record.state.status = 'done'
    record.state.progress = 1
    update()
    audit({
      caller: 'user',
      tool: 'importer.run',
      level: 'write',
      summary: `Imported ${items(id).filter((i) => i.status === 'imported').length} notes`,
      status: 'ok'
    })
  } finally {
    await rm(cache, { recursive: true, force: true })
    if (ctx.isCanceled() || ctx.signal?.aborted) {
      for (const item of items(id))
        if (!item.complete && item.noteId) {
          trashNote(item.noteId)
          saveRecord(itemKey(id, item.path), { ...item, status: 'failed', message: 'canceled', complete: true })
        }
    }
  }
}

export function registerImporterJobs(): void {
  registerJobKind<{ id: string }>(SCAN, {
    title: () => 'Scan note library',
    maxAttempts: 1,
    onCancel: ({ id }) => {
      const r = readRecord<ScanRecord>(`scan.${id}`)
      if (r) {
        r.state.status = 'canceled'
        saveRecord(`scan.${id}`, r)
        publish()
      }
    },
    async run({ id }, ctx) {
      const r = readRecord<ScanRecord>(`scan.${id}`)
      if (!r || r.state.status === 'canceled') return
      r.state.status = 'scanning'
      saveRecord(`scan.${id}`, r)
      publish()
      try {
        let savedProgress = 0
        r.library = await runInWorker<ScannedLibrary>(
          'import.scan',
          { paths: r.paths, history: importHistory() },
          (p) => {
            if (ctx.isCanceled()) return
            r.state.progress = p
            ctx.progress(p)
            if (Date.now() - savedProgress > 250 || p === 1) {
              savedProgress = Date.now()
              saveRecord(`scan.${id}`, r)
              publish()
            }
          },
          ctx.signal
        )
        if (ctx.isCanceled()) return
        const { root: _root, rootHash: _hash, files: _files, attachmentFolder: _folder, ...summary } = r.library
        r.state = { ...r.state, ...summary, progress: 1, status: 'ready' }
        saveRecord(`scan.${id}`, r)
        publish()
      } catch {
        if (!ctx.isCanceled()) {
          r.state.status = 'failed'
          r.state.error = 'scan-failed'
          saveRecord(`scan.${id}`, r)
          publish()
        }
      }
    }
  })
  registerJobKind<{ id: string }>(RUN, {
    title: () => 'Import note library',
    maxAttempts: 1,
    onCancel: ({ id }) => {
      const r = readRecord<RunRecord>(`run.${id}`)
      if (r) {
        r.state.status = active.has(id) ? 'canceling' : 'canceled'
        saveRecord(`run.${id}`, r)
        publish()
      }
    },
    async run({ id }, ctx) {
      const execute = async (): Promise<void> => {
        if (ctx.isCanceled()) return
        active.add(id)
        try {
          await importRun(id, ctx)
        } catch {
          const r = readRecord<RunRecord>(`run.${id}`)
          if (r) {
            for (const item of items(id))
              if (!item.complete && item.noteId) {
                trashNote(item.noteId)
                saveRecord(itemKey(id, item.path), { ...item, status: 'failed', message: 'interrupted', complete: true })
              }
            r.state.status = ctx.isCanceled() ? 'canceled' : 'failed'
            if (!ctx.isCanceled()) r.state.error = 'import-failed'
            saveRecord(`run.${id}`, r)
            publish()
          }
        } finally {
          active.delete(id)
          const r = readRecord<RunRecord>(`run.${id}`)
          if (r && ctx.isCanceled()) {
            r.state.status = 'canceled'
            saveRecord(`run.${id}`, r)
            publish()
          }
        }
      }
      const next = serial.then(execute, execute)
      serial = next
      await next
    }
  })
}
