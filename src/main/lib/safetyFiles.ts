import { tr } from './messages'
import { createHash } from 'crypto'
import { open, readdir, lstat, mkdir, statfs } from 'fs/promises'
import { join, dirname } from 'path'
import { copyRange } from './tar'

export async function fileHash(file: string, signal?: AbortSignal, progress?: (bytes: number) => void): Promise<string> {
  const handle = await open(file, 'r'),
    hash = createHash('sha256')
  try {
    await copyRange(handle, null, 0, (await handle.stat()).size, signal, (b) => {
      hash.update(b)
      progress?.(b.length)
    })
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
export async function copySafeFile(from: string, to: string, signal?: AbortSignal, progress?: (bytes: number) => void): Promise<void> {
  if (!(await lstat(from)).isFile()) throw new Error(tr('知识库包含不支持的链接或特殊文件', 'The vault contains unsupported links or special files'))
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  const input = await open(from, 'r'),
    output = await open(to, 'wx', 0o600)
  try {
    await copyRange(input, output, 0, (await input.stat()).size, signal, (b) => progress?.(b.length))
    await output.sync()
  } finally {
    await input.close()
    await output.close()
  }
}
export async function filesIn(root: string, prefix = '', skipDisappeared = false): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = []
  for (const name of await readdir(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return []
    throw e
  })) {
    const path = prefix ? `${prefix}/${name}` : name,
      info = await lstat(join(root, name)).catch((e: NodeJS.ErrnoException) => {
        if (skipDisappeared && e.code === 'ENOENT') return null
        throw e
      })
    if (!info) continue
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(tr('知识库包含不支持的链接或特殊文件', 'The vault contains unsupported links or special files'))
    if (info.isDirectory()) out.push(...(await filesIn(join(root, name), path, skipDisappeared)))
    else out.push({ path, size: info.size })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
export async function ensureDiskSpace(path: string, needed: number): Promise<void> {
  let root = path
  let info: Awaited<ReturnType<typeof statfs>>
  while (true) {
    try {
      info = await statfs(root)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(root) === root) throw e
      root = dirname(root)
    }
  }
  const free = info.bavail * info.bsize
  if (free < needed) {
    const extra = ((needed - free) / 1024 ** 3).toFixed(1)
    throw new Error(tr(`磁盘空间不足，还需要 ${Number(extra) > 0 ? extra + ' GB' : '至少 1 MB'}。请清理空间或选择其他磁盘。`, `Not enough disk space: ${Number(extra) > 0 ? extra + ' GB' : 'at least 1 MB'} more is needed. Free up space or choose another disk.`))
  }
}
/** 录音的发布、删除、迁移与备份共享一个顺序边界。数据库和普通素材读写不受此锁影响。 */
let tail = Promise.resolve()
export function withRecordingStore<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn)
  tail = next.then(
    () => {},
    () => {}
  )
  return next
}
