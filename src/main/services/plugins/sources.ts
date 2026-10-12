import { constants, createWriteStream } from 'fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { Transform } from 'stream'
import { createGunzip } from 'zlib'
import { pipeline } from 'stream/promises'
import JSZip from 'jszip'
import * as tar from 'tar'
import { safeRelativePath } from '@shared/plugins'

export const PLUGIN_LIMITS = { bytes: 20 * 1024 * 1024, entries: 2000, textBytes: 1024 * 1024, archiveBytes: 50 * 1024 * 1024 } as const
const isText = (name: string) => !/\.(png|jpg|jpeg|gif|webp|ico|pdf|mp3|mp4|wav|woff2?|ttf|otf)$/i.test(name)
export async function safePluginPath(root: string, relative: string): Promise<string> {
  const clean = safeRelativePath(relative),
    base = resolve(root)
  if ((await lstat(base)).isSymbolicLink()) throw new Error('Plugin symlink rejected')
  let full = base
  for (const part of clean === '.' ? [] : clean.split('/')) {
    full = join(full, part)
    try {
      if ((await lstat(full)).isSymbolicLink()) throw new Error('Plugin symlink rejected')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  if (full !== base && !full.startsWith(base + sep)) throw new Error('Unsafe plugin path')
  return full
}
interface Budget {
  bytes: number
  entries: number
}
function declared(budget: Budget, name: string, size: number): void {
  safeRelativePath(name)
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    ++budget.entries > PLUGIN_LIMITS.entries ||
    (budget.bytes += size) > PLUGIN_LIMITS.bytes ||
    (isText(name) && size > PLUGIN_LIMITS.textBytes)
  )
    throw new Error('Plugin size or entry limit exceeded')
}
function limiter(budget: Budget, name: string): Transform {
  let size = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      budget.bytes += chunk.length
      callback(
        size > (isText(name) ? PLUGIN_LIMITS.textBytes : PLUGIN_LIMITS.bytes) || budget.bytes > PLUGIN_LIMITS.bytes
          ? new Error('Plugin actual size limit exceeded')
          : null,
        chunk
      )
    }
  })
}
/** 先查中央目录中的原名和尺寸，不能让 JSZip 的路径清洗、同名覆盖隐藏恶意条目。 */
export function inspectZip(buffer: Buffer): void {
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      end = i
      break
    }
  if (end < 0) throw new Error('Invalid zip directory')
  const count = buffer.readUInt16LE(end + 10),
    offset = buffer.readUInt32LE(end + 16),
    bytes = buffer.readUInt32LE(end + 12)
  if (
    count === 0xffff ||
    offset === 0xffffffff ||
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6) ||
    buffer.readUInt16LE(end + 8) !== count ||
    offset + bytes !== end
  )
    throw new Error('Unsupported zip layout')
  if (count > PLUGIN_LIMITS.entries) throw new Error('Plugin entry limit exceeded')
  const seen = new Set<string>(),
    budget = { bytes: 0, entries: 0 }
  let cursor = offset
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid zip entry')
    const flags = buffer.readUInt16LE(cursor + 8),
      compressed = buffer.readUInt32LE(cursor + 20),
      size = buffer.readUInt32LE(cursor + 24),
      n = buffer.readUInt16LE(cursor + 28),
      extra = buffer.readUInt16LE(cursor + 30),
      comment = buffer.readUInt16LE(cursor + 32),
      local = buffer.readUInt32LE(cursor + 42)
    if (cursor + 46 + n + extra + comment > end || flags & 1 || size === 0xffffffff || compressed === 0xffffffff)
      throw new Error('Unsupported zip entry')
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + n),
      name = nameBytes.toString('utf8'),
      clean = safeRelativePath(name)
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16
    if ((mode & 0xf000) === 0xa000 || (mode & 0xf000 && ![0x4000, 0x8000].includes(mode & 0xf000)))
      throw new Error('Plugin symlink or special file rejected')
    if (seen.has(clean)) throw new Error('Duplicate zip path')
    seen.add(clean)
    declared(budget, name, size)
    if (local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid zip local header')
    const ln = buffer.readUInt16LE(local + 26),
      le = buffer.readUInt16LE(local + 28)
    if (!buffer.subarray(local + 30, local + 30 + ln).equals(nameBytes) || local + 30 + ln + le + compressed > offset)
      throw new Error('Zip local path mismatch')
    cursor += 46 + n + extra + comment
  }
  if (cursor !== end) throw new Error('Invalid zip directory length')
}
export interface PreparedPluginSource {
  root: string
  container: string
  cleanup(): Promise<void>
}
export interface PreparePluginSourceInput {
  path: string
  type: 'folder' | 'zip' | 'tar.gz'
  subdir?: string
  tempParent?: string
}
export async function preparePluginSource(input: PreparePluginSourceInput): Promise<PreparedPluginSource> {
  const container = await mkdtemp(join(input.tempParent ?? tmpdir(), 'jiwei-plugin-')),
    root = join(container, 'content')
  try {
    await mkdir(root)
    if (input.type === 'folder') await copyFolder(input.path, root)
    else {
      const st = await lstat(input.path)
      if (!st.isFile() || st.isSymbolicLink() || st.size > PLUGIN_LIMITS.archiveBytes) throw new Error('Invalid plugin archive')
      if (input.type === 'zip') {
        const buffer = await readArchive(input.path)
        inspectZip(buffer)
        const zip = await JSZip.loadAsync(buffer),
          actual = { bytes: 0, entries: 0 }
        for (const item of Object.values(zip.files)) {
          safeRelativePath(item.unsafeOriginalName ?? item.name)
          const dest = await safePluginPath(root, item.name)
          if (item.dir) {
            await mkdir(dest, { recursive: true })
            continue
          }
          await mkdir(dirname(dest), { recursive: true })
          await pipeline(item.nodeStream(), limiter(actual, item.name), createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
        }
      } else await unpackTar(input.path, root)
    }
    const selected = await safePluginPath(root, input.subdir ?? '.')
    if (!(await lstat(selected)).isDirectory()) throw new Error('Plugin subdirectory not found')
    return { root: selected, container, cleanup: () => rm(container, { recursive: true, force: true }) }
  } catch (e) {
    await rm(container, { recursive: true, force: true })
    throw e
  }
}
export async function inspectPluginFolder(root: string): Promise<string[]> {
  const budget = { bytes: 0, entries: 0 },
    files: string[] = []
  if ((await lstat(root)).isSymbolicLink() || !(await lstat(root)).isDirectory()) throw new Error('Invalid plugin folder')
  const visit = async (dir: string) => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name),
        relative = full.slice(resolve(root).length + 1),
        stat = await lstat(full)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Plugin symlink or special file rejected')
      declared(budget, relative, stat.isFile() ? stat.size : 0)
      if (stat.isDirectory()) await visit(full)
      else files.push(relative)
    }
  }
  await visit(resolve(root))
  return files.sort()
}
async function copyFolder(source: string, target: string): Promise<void> {
  // 系统 /tmp 父目录可为别名；源自身和其所有后代都必须是普通文件或目录。
  const files = await inspectPluginFolder(resolve(source)),
    canonical = await realpath(source),
    actual = { bytes: 0, entries: 0 }
  for (const relative of files) {
    const path = await safePluginPath(canonical, relative),
      dest = await safePluginPath(target, relative)
    await mkdir(dirname(dest), { recursive: true })
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await pipeline(handle.createReadStream(), limiter(actual, relative), createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
    } finally {
      await handle.close()
    }
  }
}
async function readArchive(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    chunks: Buffer[] = []
  let size = 0
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid plugin archive')
    for await (const chunk of handle.createReadStream()) {
      size += chunk.length
      if (size > PLUGIN_LIMITS.archiveBytes) throw new Error('Plugin archive size limit exceeded')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await handle.close()
  }
}
/** entry 事件看不到 PAX/GNU/ignored headers；原始 framing 层必须独立计数。 */
function tarHeaderBudget(): (chunk: Buffer) => void {
  const budget = { bytes: 0, entries: 0 },
    headerBlock = Buffer.alloc(512)
  const metadataTypes = new Set([
    'ExtendedHeader',
    'OldExtendedHeader',
    'GlobalExtendedHeader',
    'NextFileHasLongPath',
    'OldGnuLongPath',
    'NextFileHasLongLinkpath'
  ])
  let headerBytes = 0,
    bodyBytes = 0,
    metadataBytes = 0,
    metadataType = '',
    metadata: Buffer[] = []
  let extended: tar.Pax | undefined, globalExtended: tar.Pax | undefined
  return (chunk) => {
    let offset = 0
    while (offset < chunk.length) {
      if (bodyBytes) {
        const size = Math.min(bodyBytes, chunk.length - offset)
        if (metadataBytes) {
          const length = Math.min(metadataBytes, size)
          metadata.push(chunk.subarray(offset, offset + length))
          metadataBytes -= length
        }
        offset += size
        bodyBytes -= size
        if (!bodyBytes && metadata.length) {
          const value = Buffer.concat(metadata).toString('utf8')
          // 使用依赖的公开 PAX 解析器保持有效 size 与 tar.Parser 一致，防止跳错下一个 header。
          if (metadataType === 'ExtendedHeader' || metadataType === 'OldExtendedHeader') extended = tar.Pax.parse(value, extended)
          else if (metadataType === 'GlobalExtendedHeader') globalExtended = tar.Pax.parse(value, globalExtended, true)
          metadata = []
        }
        continue
      }
      const size = Math.min(512 - headerBytes, chunk.length - offset)
      chunk.copy(headerBlock, headerBytes, offset, offset + size)
      headerBytes += size
      offset += size
      if (headerBytes < 512) continue
      headerBytes = 0
      const raw = new tar.Header(headerBlock)
      if (raw.nullBlock) continue
      if (!raw.cksumValid) throw new Error('Invalid tar header checksum')
      safeRelativePath(raw.path ?? '')
      const header = new tar.Header(headerBlock, 0, extended, globalExtended),
        declaredSize = header.size ?? 0
      declared(budget, raw.path ?? '', declaredSize)
      const isMetadata = metadataTypes.has(header.type)
      if (isMetadata && declaredSize > PLUGIN_LIMITS.textBytes) throw new Error('Plugin tar metadata size limit exceeded')
      bodyBytes = Math.ceil(declaredSize / 512) * 512
      metadataType = header.type
      metadataBytes = isMetadata ? declaredSize : 0
      metadata = []
      if (!isMetadata) extended = undefined
    }
  }
}
async function unpackTar(path: string, root: string): Promise<void> {
  const buffer = await readArchive(path)
  if (buffer.length > PLUGIN_LIMITS.archiveBytes) throw new Error('Plugin archive limit exceeded')
  const declaredBudget = { bytes: 0, entries: 0 },
    names = new Set<string>()
  const run = (onEntry: (entry: tar.ReadEntry, parser: tar.Parser) => void) =>
    new Promise<void>((resolve, reject) => {
      const parser = new tar.Parser({ strict: true, maxMetaEntrySize: PLUGIN_LIMITS.textBytes }),
        unzip = createGunzip(),
        checkHeaders = tarHeaderBudget()
      let bytes = 0,
        ended = false
      const fail = (error: Error) => {
        if (ended) return
        ended = true
        unzip.destroy()
        reject(error)
      }
      parser.on('error', fail)
      unzip.on('error', fail)
      parser.on('end', () => {
        if (!ended) {
          ended = true
          resolve()
        }
      })
      parser.on('drain', () => unzip.resume())
      unzip.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        // 额外空间仅容纳 2000 个 tar headers/padding 与有界 PAX 元数据；连零填充炸弹也受限。
        if (bytes > PLUGIN_LIMITS.bytes + PLUGIN_LIMITS.entries * 1024 + PLUGIN_LIMITS.textBytes) {
          const error = new Error('Plugin actual tar size limit exceeded')
          fail(error)
          parser.abort(error)
          return
        }
        try {
          checkHeaders(chunk)
        } catch (e) {
          fail(e as Error)
          parser.abort(e as Error)
          return
        }
        if (!parser.write(chunk)) unzip.pause()
      })
      unzip.on('end', () => parser.end())
      parser.on('entry', (entry: tar.ReadEntry) => {
        try {
          onEntry(entry, parser)
        } catch (e) {
          entry.resume()
          parser.abort(e as Error)
        }
      })
      unzip.end(buffer)
    })
  // 同一压缩数据快照做两遍检查，避免两遍读取间 archive 被替换。声明超限立即中止解压。
  await run((entry) => {
    const name = safeRelativePath(entry.path)
    if (!['File', 'Directory'].includes(entry.type) || entry.linkpath) throw new Error('Plugin symlink or special file rejected')
    if (names.has(name)) throw new Error('Duplicate tar path')
    names.add(name)
    declared(declaredBudget, name, entry.size)
    entry.resume()
  })
  const actual = { bytes: 0, entries: 0 },
    writes: Promise<void>[] = []
  let failure: unknown
  try {
    await run((entry, parser) => {
      const write = async () => {
        const dest = await safePluginPath(root, entry.path)
        if (entry.type === 'Directory') {
          await mkdir(dest, { recursive: true })
          entry.resume()
          return
        }
        await mkdir(dirname(dest), { recursive: true })
        await pipeline(entry, limiter(actual, entry.path), createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
      }
      writes.push(
        write().catch((e: Error) => {
          failure ??= e
          entry.resume()
          parser.abort(e)
        })
      )
    })
  } catch (e) {
    failure ??= e
  }
  await Promise.all(writes)
  if (failure) throw failure
}
export function sourceType(path: string): PreparePluginSourceInput['type'] {
  return extname(path).toLowerCase() === '.zip' ? 'zip' : /\.tar\.gz$|\.tgz$/i.test(basename(path)) ? 'tar.gz' : 'folder'
}
