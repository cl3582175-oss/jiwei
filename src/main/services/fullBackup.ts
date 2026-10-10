import { tr } from '../lib/messages'
import { app, dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { mkdir, readdir, rm, rename, stat, link, open, lstat } from 'fs/promises'
import { basename, dirname, join, resolve, relative } from 'path'
import { hostname } from 'os'
import { createHash, randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { backupsDir, dataDir, getSqlite, closeDatabase, openDatabase } from '../db'
import { profileDb, profileDbPath, closeProfileDb } from '../db/profile'
import { defaultDataDir, readBootConfig, writeBootConfig } from '../lib/config'
import { filesIn, fileHash, copySafeFile, withRecordingStore, ensureDiskSpace } from '../lib/safetyFiles'
import { readTar, readTarBytes, writeTar, copyRange, type TarEntry } from '../lib/tar'
import { parseBackupManifest, validateArchiveEntries, fileCategory } from '../lib/backupManifest'
import { SafetyOperation } from './safetyProgress'
import { recordingsDir, cryptoOperation } from './recordingFiles'
import { vaultName } from './device'
import { flushAll } from './docs'
import { requestRendererFlush } from '../lifecycle'
import { stopJobsAndWait, startJobs } from './jobs'
import { getSettings } from './settings'
import {
  ManifestSchema,
  type BackupManifest,
  type BackupPreview,
  type BackupStatus,
  type ExternalBackup,
  type RestoreSchema
} from '@shared/backup'
import type { BackupInfo } from '@shared/types'
import type { z } from 'zod'

export const backupOperation = new SafetyOperation()
const DAY = 86400000
const snapshots = (): string => join(backupsDir(), 'snapshots')
const metaGet = (key: string): string | null =>
  (getSqlite().prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null
const metaSet = (key: string, value: string): void => {
  getSqlite().prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(key, value)
}
const migrations = (personal = false): number =>
  (
    JSON.parse(
      readFileSync(
        app.isPackaged
          ? join(process.resourcesPath, personal ? 'profile-migrations' : 'migrations', 'meta/_journal.json')
          : join(app.getAppPath(), 'resources', personal ? 'profile-migrations' : 'migrations', 'meta/_journal.json'),
        'utf8'
      )
    ) as { entries: unknown[] }
  ).entries.length
function readManifest(raw: unknown): BackupManifest {
  return parseBackupManifest(raw, migrations(), migrations(true), 2)
}
function migrationCount(db: Database.Database): number {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name='__drizzle_migrations'").get()
    ? (db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }).n
    : 0
}
const snapshotName = (): string => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
let notice: string | null = null,
  restoredVault: BackupStatus['restoredVault'] = null
const owned = (path: string, root: string): boolean => {
  const r = relative(resolve(root), resolve(path))
  return r === '' || (!r.startsWith('..') && !r.startsWith('/'))
}
function external(): ExternalBackup {
  const stored = getSettings().backup?.external
  return stored ?? { path: null, frequency: 'weekly', keep: 4 }
}
/** 小型持久化日志只含本机已选路径，启动恢复在打开 SQLite 之前执行。 */
const journalFile = (): string => join(app.getPath('userData'), 'backup-restore.json')
interface RestoreJournal {
  target: string
  stage: string
  previous: string | null
  profileStage: string | null
  profileBackup: string | null
  phase: 'extracting' | 'prepared' | 'published'
  vault?: { id: string; name: string; path: string }
}
function registerRestoredVault(j: RestoreJournal): void {
  if (!j.vault) return
  const cfg = readBootConfig()
  if (!(cfg.vaults ?? []).some((v) => v.path === j.target)) writeBootConfig({ ...cfg, vaults: [...(cfg.vaults ?? []), j.vault] })
}
function writeJournal(j: RestoreJournal): void {
  writeFileSync(journalFile() + '.tmp', JSON.stringify(j), { mode: 0o600 })
  renameSync(journalFile() + '.tmp', journalFile())
}
async function retainPrevious(j: RestoreJournal): Promise<void> {
  if (!j.previous || !existsSync(j.previous)) return
  const oldBackups = join(j.previous, 'backups'),
    newBackups = join(j.target, 'backups')
  if (existsSync(oldBackups)) {
    await mkdir(newBackups, { recursive: true })
    for (const name of await readdir(oldBackups)) {
      const from = join(oldBackups, name),
        to = join(newBackups, name)
      if (!existsSync(to)) await rename(from, to)
      else if (name === 'snapshots')
        for (const item of await readdir(from)) if (!existsSync(join(to, item))) await rename(join(from, item), join(to, item))
    }
  }
  await rm(j.previous, { recursive: true, force: true })
}
export async function initializeBackupSafety(): Promise<void> {
  const pendingBackup = readBootConfig().pendingBackup
  if (pendingBackup?.endsWith('.jiwei.partial') && !owned(pendingBackup, dataDir())) {
    await rm(pendingBackup, { force: true })
    writeBootConfig({ ...readBootConfig(), pendingBackup: null })
    notice = tr('上次备份未完成，已清理临时文件。', 'The last backup did not finish; temporary files were cleaned up.')
  }
  if (existsSync(journalFile())) {
    const j = JSON.parse(readFileSync(journalFile(), 'utf8')) as RestoreJournal
    if (j.stage !== j.target + '.restoring' || (j.previous && !j.previous.startsWith(j.target + '.previous-')))
      throw new Error(tr('恢复记录无效，请保留数据目录并联系支持', 'The restore record is invalid. Keep the data folder and contact support.'))
    const published = !existsSync(j.stage) && existsSync(join(j.target, 'jiwei.db')) && j.phase !== 'extracting'
    if (!published) {
      if (j.previous && existsSync(j.previous) && !existsSync(j.target)) await rename(j.previous, j.target)
      await rm(j.stage, { recursive: true, force: true })
      if (j.profileStage) await rm(j.profileStage, { force: true })
      notice = tr('上次恢复未完成，已清理。原知识库与个人档案已保留。', 'The last restore did not finish and was cleaned up. Your original vault and profile were kept.')
    } else {
      if (j.profileStage && existsSync(j.profileStage)) {
        await rm(profileDbPath() + '-wal', { force: true })
        await rm(profileDbPath() + '-shm', { force: true })
        await rename(j.profileStage, profileDbPath())
      }
      await retainPrevious(j)
      registerRestoredVault(j)
      restoredVault = j.vault ?? null
      notice = tr('上次恢复已完成，备份和个人档案已安全保存。', 'The last restore finished; backups and profile were saved safely.')
    }
    await rm(journalFile(), { force: true })
  }
  // 只清理应用自己的暂存物，不递归搜索或删除用户文件。
  for (const root of [backupsDir(), snapshots()]) {
    for (const name of await readdir(root).catch(() => []))
      if (name.endsWith('.partial')) {
        await rm(join(root, name), { recursive: true, force: true })
        notice ??= tr('上次备份未完成，已清理临时文件。', 'The last backup did not finish; temporary files were cleaned up.')
      }
  }
  const ext = readBootConfig().dataDir
  if (ext && existsSync(ext + '.restoring')) {
    await rm(ext + '.restoring', { recursive: true, force: true })
    notice = tr('上次恢复未完成，已清理', 'The last restore did not finish and was cleaned up')
  }
}
export async function listSnapshots(): Promise<BackupInfo[]> {
  const result: BackupInfo[] = []
  for (const name of await readdir(snapshots()).catch(() => [])) {
    if (name.endsWith('.partial')) continue
    try {
      const m = readManifest(JSON.parse(readFileSync(join(snapshots(), name, 'manifest.json'), 'utf8')))
      result.push({ name: `snapshots/${name}`, createdAt: m.createdAt, size: m.totalSize, kind: m.kind, format: 'snapshot' })
    } catch {
      /* 不把损坏或未发布的快照当成完整备份。 */
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt)
}
async function makeSnapshot(
  kind: BackupManifest['kind'],
  includeProfile: boolean,
  signal: AbortSignal,
  stagingOnly = false
): Promise<{ path: string; manifest: BackupManifest }> {
  const name = snapshotName(),
    target = join(snapshots(), name),
    stage = target + '.partial'
  await mkdir(stage, { recursive: true, mode: 0o700 })
  try {
    await withRecordingStore(async () => {
      signal.throwIfAborted()
      flushAll()
      await getSqlite().backup(join(stage, 'jiwei.db'), {
        progress: () => {
          signal.throwIfAborted()
          return 200
        }
      })
      if (includeProfile) {
        await mkdir(join(stage, 'profile'))
        await profileDb().backup(join(stage, 'profile/memory.db'), {
          progress: () => {
            signal.throwIfAborted()
            return 200
          }
        })
      }
      const assets = await filesIn(join(dataDir(), 'assets')),
        recordings = (await filesIn(recordingsDir())).filter((f) => /(?:manifest\.json|\.webm(?:\.enc)?)$/.test(f.path))
      await ensureDiskSpace(stage, recordings.reduce((n, f) => n + f.size, 0) + 16 * 1024 * 1024)
      const total = assets.reduce((n, f) => n + f.size, 0) + recordings.reduce((n, f) => n + f.size, 0)
      let done = 0
      backupOperation.progress(0, total)
      backupOperation.value.message = tr('正在保存数据库、素材和录音', 'Saving database, files and recordings')
      for (const [root, files] of [
        ['assets', assets],
        ['recordings', recordings]
      ] as const)
        for (const f of files) {
          signal.throwIfAborted()
          const from = join(dataDir(), root, f.path),
            to = join(stage, root, f.path)
          await mkdir(dirname(to), { recursive: true, mode: 0o700 })
          if (root === 'assets') {
            try {
              await link(from, to)
            } catch (e) {
              if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
              await copySafeFile(from, to, signal)
            }
          } else await copySafeFile(from, to, signal)
          backupOperation.progress((done += f.size))
        }
    })
    // SQLite 在线备份继承 WAL 标志。先切回独立文件模式，再列清单与计算哈希，
    // 避免只读统计产生未列入清单的 -wal/-shm，导致本地快照无法回退。
    for (const file of ['jiwei.db', ...(includeProfile ? ['profile/memory.db'] : [])]) {
      const db = new Database(join(stage, file))
      try {
        db.pragma('journal_mode = DELETE')
        if (file === 'jiwei.db' && db.prepare("SELECT 1 FROM sqlite_master WHERE name='translation_cache'").get()) {
          // 只清理快照副本；secure_delete 同时擦除页内缓存文本，当前库继续使用缓存。
          db.pragma('secure_delete = ON')
          db.exec('DELETE FROM translation_cache')
        }
      } finally {
        db.close()
      }
    }
    const files = await filesIn(stage),
      total = files.reduce((n, f) => n + f.size, 0)
    let done = 0
    backupOperation.progress(0, total)
    backupOperation.value.message = tr('正在校验完整备份', 'Verifying the full backup')
    const hashes: BackupManifest['files'] = []
    for (const f of files)
      hashes.push({ ...f, sha256: await fileHash(join(stage, f.path), signal, (n) => backupOperation.progress((done += n))) })
    const db = new Database(join(stage, 'jiwei.db'), { readonly: true }),
      personal = includeProfile ? new Database(join(stage, 'profile/memory.db'), { readonly: true }) : null
    let manifest: BackupManifest
    try {
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get() as { n: number }).n
      manifest = ManifestSchema.parse({
        format: 1,
        appVersion: app.getVersion(),
        knowledgeVersion: migrationCount(db),
        profileVersion: personal ? migrationCount(personal) : 0,
        profileLegacyVersion: personal ? personal.pragma('user_version', { simple: true }) : 0,
        createdAt: Date.now(),
        device: hostname(),
        vault: vaultName() ?? tr('我的知识库', 'My vault'),
        kind,
        notes: count('notes'),
        sources: count('sources'),
        recordings: count('recordings'),
        assets: (db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n,
        totalSize: total,
        includeProfile,
        encryptedRecordings: hashes.some((f) => f.path.startsWith('recordings/') && f.path.endsWith('.enc')),
        files: hashes
      })
    } finally {
      db.close()
      personal?.close()
    }
    await writeFileDurable(join(stage, 'manifest.json'), JSON.stringify(manifest))
    signal.throwIfAborted()
    if (!stagingOnly) {
      await rename(stage, target)
      return { path: target, manifest }
    }
    return { path: stage, manifest }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}
async function writeFileDurable(file: string, text: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
export async function fullBackupNow(includeProfile = true): Promise<BackupInfo> {
  return backupOperation.run(
    tr('完整备份', 'Full backup'),
    async (signal) => {
      const { path, manifest } = await makeSnapshot('manual', includeProfile, signal)
      return {
        name: relative(backupsDir(), path),
        size: manifest.totalSize,
        createdAt: manifest.createdAt,
        kind: 'manual',
        format: 'snapshot'
      }
    },
    tr('完整备份已保存。可以导出文件，或从列表恢复。', 'Full backup saved. You can export it as a file or restore it from the list.')
  )
}
export async function automaticSnapshot(): Promise<void> {
  if (backupOperation.running) return
  const last = (await listSnapshots()).find((b) => b.kind === 'auto')
  if (!last || Date.now() - last.createdAt >= DAY)
    await backupOperation.run(tr('自动完整备份', 'Automatic full backup'), (signal) => makeSnapshot('auto', true, signal), tr('每日完整备份已保存', 'Daily full backup saved'))
  const all = (await listSnapshots()).filter((b) => b.kind === 'auto'),
    keep = new Set<string>()
  for (const [span, count] of [
    [DAY, 7],
    [7 * DAY, 4],
    [30 * DAY, 12]
  ]) {
    const buckets = new Set<number>()
    for (const item of all) {
      const b = Math.floor((Date.now() - item.createdAt) / span)
      if (b < count && !buckets.has(b)) {
        buckets.add(b)
        keep.add(item.name)
      }
    }
  }
  for (const item of all) if (!keep.has(item.name)) await rm(join(backupsDir(), item.name), { recursive: true, force: true })
  await externalBackupIfDue()
}
export function archiveName(): string {
  return `${tr('积微备份', 'Jiwei-backup')}-${(vaultName() ?? tr('我的知识库', 'My vault')).replace(/[^\p{L}\p{N}-]/gu, '-').slice(0, 80) || tr('知识库', 'vault')}-${new Date().toISOString().slice(0, 10)}.jiwei`
}
async function exportTo(path: string, includeProfile: boolean, signal: AbortSignal): Promise<void> {
  if (!path.endsWith('.jiwei')) throw new Error(tr('请保存为 .jiwei 备份文件', 'Save as a .jiwei backup file'))
  if (owned(path, dataDir())) throw new Error(tr('请把归档保存到知识库以外的位置', 'Save the archive outside the vault folder'))
  const partial = path + '.partial'
  let snapshot: string | null = null
  if (existsSync(partial)) throw new Error(tr('这个位置有未完成的备份，请选择其他文件名', 'An unfinished backup exists here. Choose another file name.'))
  writeBootConfig({ ...readBootConfig(), pendingBackup: partial })
  try {
    const result = await makeSnapshot('manual', includeProfile, signal)
    snapshot = result.path
    await ensureDiskSpace(dirname(path), result.manifest.totalSize + result.manifest.files.length * 1024 + 16 * 1024 * 1024)
    let done = 0
    backupOperation.progress(0, result.manifest.totalSize)
    backupOperation.value.message = tr('正在写入备份文件', 'Writing backup file')
    await writeTar(
      partial,
      [
        { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(result.manifest)) },
        ...result.manifest.files.map((f) => ({ path: f.path, file: join(snapshot!, f.path) }))
      ],
      signal,
      (n) => backupOperation.progress((done += n))
    )
    const inspected = await inspectArchive(partial, signal)
    await verifySource({ path: partial, ...inspected }, signal)
    signal.throwIfAborted()
    await rename(partial, path)
  } finally {
    await rm(partial, { force: true })
    if (snapshot) await rm(snapshot, { recursive: true, force: true })
    writeBootConfig({ ...readBootConfig(), pendingBackup: null })
  }
}
export async function exportBackup(includeProfile = true): Promise<string | null> {
  const res = await dialog.showSaveDialog({
    title: tr('导出完整备份', 'Export full backup'),
    defaultPath: join(app.getPath('documents'), archiveName()),
    filters: [{ name: tr('积微备份', 'Jiwei backup'), extensions: ['jiwei'] }]
  })
  if (res.canceled || !res.filePath) return null
  await backupOperation.run(
    tr('导出备份', 'Export backup'),
    (signal) => exportTo(res.filePath!, includeProfile, signal),
    tr('备份文件已导出。换电脑时，打开积微并选择“从备份恢复”。', 'Backup exported. On a new computer, open Jiwei and choose “Restore from backup”.')
  )
  return res.filePath
}
export async function pickExternalBackup(): Promise<string | null> {
  const res = await dialog.showOpenDialog({ title: tr('选择外部备份位置', 'Choose external backup location'), properties: ['openDirectory', 'createDirectory'] })
  const path = res.canceled ? null : res.filePaths[0]
  if (path && owned(path, dataDir())) throw new Error(tr('外部备份位置需要在知识库目录以外', 'The external backup location must be outside the vault folder'))
  return path ?? null
}
export async function externalBackupIfDue(): Promise<void> {
  const e = external(),
    last = Number(metaGet('backup.external.last') ?? 0)
  if (!e.path || backupOperation.running || Date.now() - last < (e.frequency === 'daily' ? DAY : 7 * DAY)) return
  if (!(await stat(e.path).catch(() => null))?.isDirectory()) {
    metaSet('backup.external.unavailable', '1')
    return
  }
  const path = join(e.path, archiveName().replace('.jiwei', `-${Date.now()}.jiwei`))
  try {
    await backupOperation.run(tr('外部备份', 'External backup'), (signal) => exportTo(path, true, signal), tr('外部备份已保存', 'External backup saved'))
    // 只保留本库通过日志登记的导出，不删除同位置其他知识库或用户文件。
    const previous = JSON.parse(metaGet('backup.external.files') ?? '[]') as string[],
      files = [path, ...previous]
    metaSet('backup.external.files', JSON.stringify(files.slice(0, e.keep)))
    metaSet('backup.external.last', String(Date.now()))
    metaSet('backup.external.unavailable', '0')
    for (const old of files.slice(e.keep))
      if (dirname(old) === resolve(e.path) && (basename(old).startsWith('积微备份-') || basename(old).startsWith('Jiwei-backup-')) && old.endsWith('.jiwei'))
        await rm(old, { force: true })
  } catch {
    metaSet('backup.external.unavailable', '1')
  }
}
export async function backupStatus(): Promise<BackupStatus> {
  const local = (await listSnapshots())[0],
    e = external(),
    last = Number(metaGet('backup.external.last') ?? 0)
  return {
    progress: backupOperation.value,
    localAt: local?.createdAt ?? null,
    externalAt: last || null,
    externalUnavailable:
      !!e.path && (metaGet('backup.external.unavailable') === '1' || !(await stat(e.path).catch(() => null))?.isDirectory()),
    external: e,
    bytes: await allocatedBackupBytes(),
    notice,
    restoredVault
  }
}
async function allocatedBackupBytes(): Promise<number> {
  let bytes = 0
  const seen = new Set<string>()
  for (const file of await filesIn(backupsDir(), '', true)) {
    const info = await stat(join(backupsDir(), file.path)).catch(() => null)
    if (!info) continue
    const identity = `${info.dev}:${info.ino}`
    if (!seen.has(identity)) {
      seen.add(identity)
      bytes += info.blocks ? info.blocks * 512 : info.size
    }
  }
  return bytes
}
interface BackupSource {
  path: string
  manifest: BackupManifest
  entries?: TarEntry[]
}
const previews = new Map<string, BackupSource>()
async function inspectArchive(path: string, signal?: AbortSignal): Promise<{ manifest: BackupManifest; entries: TarEntry[] }> {
  const entries = await readTar(path, signal)
  if (entries[0]?.path !== 'manifest.json') throw new Error(tr('备份中找不到清单', 'The backup has no manifest'))
  let raw: unknown
  try {
    raw = JSON.parse((await readTarBytes(path, entries[0], 64 * 1024 * 1024)).toString('utf8'))
  } catch {
    throw new Error(tr('备份清单已损坏', 'The backup manifest is damaged'))
  }
  const manifest = readManifest(raw)
  validateArchiveEntries(entries, manifest)
  return { manifest, entries }
}
export async function previewBackup(name?: string): Promise<BackupPreview | null> {
  let source: BackupSource
  if (name) {
    if (!/^snapshots\/[\w-]+$/.test(name)) throw new Error(tr('旧数据库备份仅含笔记数据。请先导出完整备份，再恢复到新知识库。', 'Old database backups contain notes only. Export a full backup first, then restore it as a new vault.'))
    const path = join(backupsDir(), name)
    if (!(await lstat(path)).isDirectory()) throw new Error(tr('找不到这个备份', 'Backup not found'))
    source = { path, manifest: readManifest(JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))) }
  } else {
    const choice = await dialog.showOpenDialog({
      title: tr('从备份恢复', 'Restore from backup'),
      filters: [{ name: tr('积微备份', 'Jiwei backup'), extensions: ['jiwei'] }],
      properties: ['openFile']
    })
    if (choice.canceled || !choice.filePaths[0]) return null
    source = { path: choice.filePaths[0], ...(await inspectArchive(choice.filePaths[0])) }
  }
  const token = randomUUID()
  previews.clear()
  previews.set(token, source)
  const personal = profileDb(),
    tables = ['memories', 'concepts', 'people', 'voiceprints', 'vocabulary']
  const empty = tables.every(
    (t) => !personal.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(t) || !personal.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get()
  )
  return { token, manifest: source.manifest, profileEmpty: empty, databaseOnly: false }
}
async function verifySource(source: BackupSource, signal: AbortSignal, destination?: string, includeProfile = true): Promise<void> {
  // 预览与操作间再次读清单和索引，阻止换包和缺失／新增条目。
  if (source.entries) {
    const current = await inspectArchive(source.path, signal)
    if (JSON.stringify(current.manifest) !== JSON.stringify(source.manifest)) throw new Error(tr('备份在预览后已改变，请重新选择', 'The backup changed after preview. Choose it again.'))
    source.entries = current.entries
  } else {
    const current = await filesIn(source.path),
      actual = new Set(current.map((f) => f.path))
    if (
      actual.size !== source.manifest.files.length + 1 ||
      !actual.has('manifest.json') ||
      source.manifest.files.some((f) => !actual.has(f.path))
    )
      throw new Error(tr('本地备份文件缺失或已改变', 'Local backup files are missing or changed'))
  }
  let done = 0
  backupOperation.progress(0, source.manifest.totalSize)
  backupOperation.value.message = tr('正在逐项校验并恢复', 'Verifying and restoring')
  const archive = source.entries ? await open(source.path, 'r') : null
  try {
    for (const file of source.manifest.files) {
      signal.throwIfAborted()
      const outputPath = destination && (includeProfile || !file.path.startsWith('profile/')) ? join(destination, file.path) : null
      if (outputPath) await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
      const output = outputPath ? await open(outputPath, 'wx', 0o600) : null
      const input = archive ?? (await open(join(source.path, file.path), 'r')),
        hash = createHash('sha256')
      try {
        if (!archive && (await input.stat()).size !== file.size) throw new Error(tr(`${fileCategory(file.path)}已损坏`, `${fileCategory(file.path)} is damaged`))
        const entry = source.entries?.find((e) => e.path === file.path)
        await copyRange(input, output, entry?.offset ?? 0, file.size, signal, (b) => {
          hash.update(b)
          backupOperation.progress((done += b.length))
        })
        if (hash.digest('hex') !== file.sha256) throw new Error(tr(`${fileCategory(file.path)}校验失败，备份已损坏，当前知识库未改变`, `${fileCategory(file.path)} failed verification. The backup is damaged; your current vault was not changed.`))
        await output?.sync()
      } finally {
        await output?.close()
        if (!archive) await input.close()
      }
    }
  } finally {
    await archive?.close()
  }
}
export async function restoreBackup(input: z.infer<typeof RestoreSchema>): Promise<{ id: string; name: string; path: string } | null> {
  const source = previews.get(input.token)
  if (!source) throw new Error(tr('备份预览已过期，请重新选择', 'The backup preview expired. Choose it again.'))
  if (backupOperation.running || cryptoOperation.running) throw new Error(tr('请先完成或暂停备份和录音迁移', 'Finish or pause the backup and recording migration first'))
  if (input.mode === 'replace' && !input.confirmed) throw new Error(tr('替换知识库需要再次确认', 'Replacing the vault needs confirmation'))
  if (getSqlite().prepare("SELECT 1 FROM recordings WHERE status IN ('recording','paused','finalizing') AND deleted_at IS NULL").get())
    throw new Error(tr('请先结束或恢复未完成的录音，再恢复知识库', 'Finish or recover the unfinished recording before restoring'))
  let target = dataDir()
  if (input.mode === 'new') {
    const pick = await dialog.showSaveDialog({
      title: tr('选择新知识库的文件夹', 'Choose a folder for the new vault'),
      defaultPath: join(dirname(defaultDataDir()), `${tr('积微-恢复', 'Jiwei-restored')}-${new Date().toISOString().slice(0, 10)}`),
      buttonLabel: tr('恢复到这个文件夹', 'Restore here')
    })
    if (pick.canceled || !pick.filePath) return null
    target = resolve(pick.filePath)
    if (existsSync(target) || owned(target, dataDir()) || owned(dataDir(), target))
      throw new Error(tr('请选择尚不存在且位于当前知识库之外的文件夹', 'Choose a new folder outside the current vault'))
  }
  const stage = target + '.restoring'
  if (existsSync(stage)) throw new Error(tr('这个位置存在未完成的恢复，请重新启动积微后再试', 'An unfinished restore exists here. Restart Jiwei and try again.'))
  return backupOperation.run(
    tr('恢复知识库', 'Restore vault'),
    async (signal) => {
      const journal: RestoreJournal = {
        target,
        stage,
        previous: input.mode === 'replace' ? target + '.previous-' + randomUUID() : null,
        profileStage: null,
        profileBackup: null,
        phase: 'extracting',
        vault: input.mode === 'new' ? { id: randomUUID(), name: tr(`${source.manifest.vault}（恢复）`, `${source.manifest.vault} (restored)`), path: target } : undefined
      }
      writeJournal(journal)
      let published = false
      let jobsStopped = false
      try {
        await ensureDiskSpace(dirname(target), source.manifest.totalSize + 16 * 1024 * 1024)
        await mkdir(stage, { recursive: true, mode: 0o700 })
        await verifySource(source, signal, stage, input.includeProfile)
        const restored = new Database(join(stage, 'jiwei.db'))
        try {
          if (migrationCount(restored) !== source.manifest.knowledgeVersion || restored.pragma('quick_check', { simple: true }) !== 'ok')
            throw new Error(tr('知识库数据库版本或完整性校验失败', 'The vault database failed version or integrity checks'))
          if (restored.prepare("SELECT 1 FROM sqlite_master WHERE name='translation_cache'").get())
            restored.exec('DELETE FROM translation_cache')
          restored
            .prepare("DELETE FROM meta WHERE key IN ('backup.external.files','backup.external.last','backup.external.unavailable')")
            .run()
          if (journal.vault) {
            const set = restored.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)')
            set.run('vault_id', journal.vault.id)
            set.run('vault_name', journal.vault.name)
          }
          restored.pragma('wal_checkpoint(TRUNCATE)')
        } finally {
          restored.close()
        }
        if (input.includeProfile && source.manifest.includeProfile) {
          const db = new Database(join(stage, 'profile/memory.db'), { readonly: true })
          try {
            if (
              migrationCount(db) !== source.manifest.profileVersion ||
              db.pragma('user_version', { simple: true }) !== source.manifest.profileLegacyVersion ||
              db.pragma('quick_check', { simple: true }) !== 'ok'
            )
              throw new Error(tr('个人档案数据库校验失败', 'The profile database failed verification'))
          } finally {
            db.close()
          }
          journal.profileBackup = join(app.getPath('userData'), 'profile', `pre-restore-${Date.now()}.db`)
          await profileDb().backup(journal.profileBackup)
          journal.profileStage = profileDbPath() + '.restoring'
          await copySafeFile(join(stage, 'profile/memory.db'), journal.profileStage, signal)
        }
        if (input.mode === 'replace') {
          backupOperation.value.message = tr('正在保存恢复前的完整备份', 'Saving a full backup before restoring')
          await requestRendererFlush()
          await makeSnapshot('pre-restore', true, signal)
        }
        signal.throwIfAborted()
        journal.phase = 'prepared'
        writeJournal(journal)
        // 发布阶段不可取消，SQLite 关闭后由持久化日志保证重启回退或完成。
        if (input.mode === 'replace' || journal.profileStage) {
          await stopJobsAndWait()
          jobsStopped = true
        }
        if (input.mode === 'replace') {
          flushAll()
          closeDatabase()
          await rename(target, journal.previous!)
        }
        await rename(stage, target)
        published = true
        journal.phase = 'published'
        writeJournal(journal)
        if (journal.profileStage) {
          closeProfileDb()
          await rm(profileDbPath() + '-wal', { force: true })
          await rm(profileDbPath() + '-shm', { force: true })
          await rename(journal.profileStage, profileDbPath())
        }
        await retainPrevious(journal)
        registerRestoredVault(journal)
        await rm(journalFile(), { force: true })
        previews.delete(input.token)
        restoredVault = journal.vault ?? { id: randomUUID(), name: source.manifest.vault, path: target }
        if (input.mode === 'replace') {
          app.relaunch()
          app.exit(0)
        }
        return restoredVault
      } catch (error) {
        if (!published) {
          if (journal.previous && existsSync(journal.previous) && !existsSync(target)) await rename(journal.previous, target)
          await rm(stage, { recursive: true, force: true })
          if (journal.profileStage) await rm(journal.profileStage, { force: true })
          await rm(journalFile(), { force: true })
        }
        throw error
      } finally {
        if (jobsStopped && (input.mode === 'new' || !published)) {
          if (input.mode === 'replace') await openDatabase()
          startJobs()
        }
      }
    },
    tr('知识库已恢复。可以立即切换，或稍后在知识库列表中打开。', 'Vault restored. Switch now, or open it later from the vault list.')
  )
}
