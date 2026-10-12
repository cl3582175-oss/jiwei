import { mkdir, readdir, rm, rename, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { compareVersions, type UpgradeNotice } from '@shared/updates'

export async function upgradeSnapshot(input: {
  from: string
  to: string
  directory: string
  now?: number
  backup(path: string): Promise<unknown>
}): Promise<UpgradeNotice | null> {
  try {
    if (compareVersions(input.to, input.from) <= 0) return null
  } catch {
    return null
  }
  const notice: UpgradeNotice = { from: input.from, to: input.to }
  const name = `pre-update-${String(input.now ?? Date.now()).padStart(16, '0')}-${input.from}-to-${input.to}.db`
  const partial = join(input.directory, name + '.partial')
  try {
    await mkdir(input.directory, { recursive: true, mode: 0o700 })
    await input.backup(partial)
    await chmod(partial, 0o600)
    await rename(partial, join(input.directory, name))
    notice.backupName = name
    const snapshots = (await readdir(input.directory))
      .filter((n) => /^pre-update-\d{16}-[0-9A-Za-z.+-]+\.db$/.test(n))
      .sort()
      .reverse()
    for (const old of snapshots.slice(2)) await rm(join(input.directory, old))
  } catch {
    notice.backupFailed = true
    await rm(partial, { force: true }).catch(() => undefined)
  }
  return notice
}
