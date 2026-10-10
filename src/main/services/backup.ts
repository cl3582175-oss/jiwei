import { join } from 'path'
import { readdir, rm, stat, rename } from 'fs/promises'
import log from 'electron-log/main'
import { backupsDir, getSqlite } from '../db'
import type { BackupInfo } from '@shared/types'
import { listSnapshots, automaticSnapshot } from './fullBackup'

const DAY = 86_400_000
const PREFIX = 'jiwei-'

function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export async function listBackups(): Promise<BackupInfo[]> {
  const names = (await readdir(backupsDir())).filter((n) => n.endsWith('.db'))
  const out: BackupInfo[] = []
  for (const name of names) {
    const s = await stat(join(backupsDir(), name))
    out.push({ name, size: s.size, createdAt: s.mtimeMs, kind: name.startsWith('pre-migrate') ? 'pre-migrate' : 'auto' })
  }
  return [...out, ...(await listSnapshots())].sort((a, b) => b.createdAt - a.createdAt)
}

/** 在线备份（不阻塞读写） */
export async function backupNow(): Promise<BackupInfo> {
  const name = `${PREFIX}${stamp()}.db`
  const partial = join(backupsDir(), name + '.partial')
  try {
    await getSqlite().backup(partial)
    await rename(partial, join(backupsDir(), name))
  } finally {
    await rm(partial, { force: true })
  }
  const s = await stat(join(backupsDir(), name))
  log.info('[backup] created', name)
  return { name, size: s.size, createdAt: s.mtimeMs, kind: 'auto' }
}

/**
 * 保留策略：最近 7 天每天 1 份、最近 4 周每周 1 份、最近 12 个月每月 1 份。
 * 迁移前备份保留最近 3 份。
 */
export async function pruneBackups(): Promise<void> {
  const all = (await listBackups()).filter((b) => b.format !== 'snapshot')
  const keep = new Set<string>()
  const autos = all.filter((b) => b.kind === 'auto')
  const bucketKeep = (span: number, count: number): void => {
    const seen = new Set<number>()
    for (const b of autos) {
      const age = Date.now() - b.createdAt
      const bucket = Math.floor(age / span)
      if (bucket < count && !seen.has(bucket)) {
        seen.add(bucket)
        keep.add(b.name)
      }
    }
  }
  bucketKeep(DAY, 7)
  bucketKeep(7 * DAY, 4)
  bucketKeep(30 * DAY, 12)
  all
    .filter((b) => b.kind === 'pre-migrate')
    .slice(0, 3)
    .forEach((b) => keep.add(b.name))
  for (const b of all) if (!keep.has(b.name)) await rm(join(backupsDir(), b.name), { force: true })
}

/** 启动时调用：距上次自动备份超过 24 小时则备份 */
export async function autoBackup(): Promise<void> {
  try {
    const last = (await listBackups()).find((b) => b.kind === 'auto' && b.format !== 'snapshot')
    if (!last || Date.now() - last.createdAt > DAY) await backupNow()
    await pruneBackups()
    await automaticSnapshot()
  } catch (e) {
    log.error('[backup] failed', e)
  }
}
