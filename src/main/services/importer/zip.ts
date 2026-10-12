import { open, lstat, mkdir, rm } from 'fs/promises'
import { createReadStream, constants, openSync, type ReadStream } from 'fs'
import type { Readable } from 'stream'
import { createInflateRaw } from 'zlib'
import { dirname, join, resolve } from 'path'
const MAX_BYTES = 2 * 1024 ** 3,
  MAX_FILES = 50000,
  MAX_FILE = 5 * 1024 ** 2
const fail = (code: string): never => {
  throw new Error(`zip-${code}`)
}
const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc(bytes: Uint8Array, value = 0): number {
  let c = value ^ 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function validPath(name: string): string {
  if (
    !name ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name) ||
    name.includes(':') ||
    Array.from(name).some((c) => c.charCodeAt(0) < 32)
  )
    fail('path')
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    fail('path')
  return parts.join('/').normalize('NFC')
}
function filename(raw: Buffer, extra: Buffer, flags: number): string {
  let name: string
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return fail('format')
  }
  validPath(name)
  if (!(flags & 0x800) && raw.some((b) => b > 127) && !extra.length) fail('format')
  let at = 0
  while (at < extra.length) {
    if (at + 4 > extra.length) fail('format')
    const id = extra.readUInt16LE(at),
      length = extra.readUInt16LE(at + 2)
    at += 4
    if (at + length > extra.length) fail('format')
    if (id === 1) fail('format') // ZIP64 is unnecessary under the declared 2 GB / 50000 limits.
    if (id === 0x7075) {
      const data = extra.subarray(at, at + length)
      if (data.length < 5 || data[0] !== 1 || data.readUInt32LE(1) !== crc(raw)) fail('format')
      try {
        const unicode = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(5))
        validPath(unicode)
        name = unicode
      } catch (e) {
        if (e instanceof Error && e.message === 'zip-path') throw e
        fail('format')
      }
    }
    at += length
  }
  return name
}
interface Entry {
  name: string
  directory: boolean
  flags: number
  method: number
  crc: number
  compressed: number
  size: number
  offset: number
  start: number
  end: number
}

/** Read raw central/local headers before creating files; bounded streaming inflate, never JSZip sanitization. */
export async function extractSafeZip(
  path: string,
  destination: string,
  signal?: AbortSignal,
  progress?: (n: number) => void
): Promise<string[]> {
  if ((await lstat(path)).isSymbolicLink()) fail('link')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let created = false
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > MAX_BYTES || before.size < 22) fail('limit')
    const read = async (position: number, length: number): Promise<Buffer> => {
      signal?.throwIfAborted()
      if (position < 0 || length < 0 || position + length > before.size) fail('format')
      const buffer = Buffer.alloc(length)
      let at = 0
      while (at < length) {
        const r = await file.read(buffer, at, length - at, position + at)
        if (!r.bytesRead) fail('format')
        at += r.bytesRead
      }
      return buffer
    }
    const tailOffset = Math.max(0, before.size - 65557),
      tail = await read(tailOffset, before.size - tailOffset)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        eocd = i
        break
      }
    if (eocd < 0) fail('format')
    if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6)) fail('format')
    const count = tail.readUInt16LE(eocd + 10),
      centralSize = tail.readUInt32LE(eocd + 12),
      centralOffset = tail.readUInt32LE(eocd + 16)
    if (count > MAX_FILES || count === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('limit')
    if (tail.readUInt16LE(eocd + 8) !== count || centralOffset + centralSize !== tailOffset + eocd) fail('format')
    const entries: Entry[] = [],
      names = new Set<string>()
    let offset = centralOffset,
      total = 0
    for (let i = 0; i < count; i++) {
      const h = await read(offset, 46)
      if (h.readUInt32LE(0) !== 0x02014b50 || h.readUInt16LE(34)) fail('format')
      const flags = h.readUInt16LE(8),
        method = h.readUInt16LE(10),
        n = h.readUInt16LE(28),
        x = h.readUInt16LE(30),
        c = h.readUInt16LE(32)
      if (n > 4096 || flags & 0x41 || ![0, 8].includes(method)) fail('format')
      const mode = (h.readUInt32LE(38) >>> 16) & 0xf000
      if (mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000)) fail('link')
      const raw = await read(offset + 46, n + x),
        name = filename(raw.subarray(0, n), raw.subarray(n), flags),
        key = validPath(name).toLowerCase()
      if (names.has(key)) fail('path')
      names.add(key)
      const size = h.readUInt32LE(24),
        compressed = h.readUInt32LE(20)
      if (size === 0xffffffff || compressed === 0xffffffff || (total += size) > MAX_BYTES) fail('limit')
      const directory = name.endsWith('/') || mode === 0x4000
      if (directory && size) fail('format')
      entries.push({
        name,
        directory,
        flags,
        method,
        crc: h.readUInt32LE(16),
        size,
        compressed,
        offset: h.readUInt32LE(42),
        start: 0,
        end: 0
      })
      offset += 46 + n + x + c
      if (offset > centralOffset + centralSize) fail('format')
    }
    if (offset !== centralOffset + centralSize) fail('format')
    for (const e of entries) {
      const h = await read(e.offset, 30)
      if (h.readUInt32LE(0) !== 0x04034b50 || h.readUInt16LE(6) !== e.flags || h.readUInt16LE(8) !== e.method) fail('format')
      const n = h.readUInt16LE(26),
        x = h.readUInt16LE(28),
        raw = await read(e.offset + 30, n + x)
      if (n > 4096 || filename(raw.subarray(0, n), raw.subarray(n), e.flags) !== e.name) fail('path')
      if (!(e.flags & 8) && (h.readUInt32LE(14) !== e.crc || h.readUInt32LE(18) !== e.compressed || h.readUInt32LE(22) !== e.size))
        fail('format')
      e.start = e.offset + 30 + n + x
      e.end = e.start + e.compressed
      if (e.end > centralOffset) fail('format')
    }
    const ranges = [...entries].sort((a, b) => a.offset - b.offset)
    for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].end) fail('format')
    await mkdir(destination, { mode: 0o700 })
    created = true
    const root = resolve(destination)
    let actual = 0
    const skipped: string[] = []
    for (const [index, e] of entries.entries()) {
      signal?.throwIfAborted()
      const target = join(root, ...validPath(e.name).split('/'))
      if (e.directory) {
        await mkdir(target, { recursive: true, mode: 0o700 })
        continue
      }
      if (e.size > MAX_FILE) {
        skipped.push(e.name)
        continue
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const out = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      let source: ReadStream | null = null
      let stream: Readable | null = null
      const abort = (): void => {
        source?.destroy(new Error('zip-canceled'))
        stream?.destroy(new Error('zip-canceled'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      let size = 0,
        checksum = 0
      try {
        source = e.compressed
          ? createReadStream(path, {
              fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
              autoClose: true,
              start: e.start,
              end: e.end - 1
            })
          : null
        stream = e.method === 8 ? (source?.pipe(createInflateRaw()) ?? null) : source
        if (source && stream && stream !== source) source.on('error', (error) => stream?.destroy(error))
        if (stream)
          for await (const part of stream) {
            const bytes = part as Buffer
            size += bytes.length
            actual += bytes.length
            if (size > e.size || size > MAX_FILE || actual > MAX_BYTES) fail('size')
            checksum = crc(bytes, checksum)
            let at = 0
            while (at < bytes.length) {
              const r = await out.write(bytes, at, bytes.length - at)
              if (!r.bytesWritten) fail('extract')
              at += r.bytesWritten
            }
          }
        if (size !== e.size || checksum !== e.crc) fail('integrity')
      } finally {
        signal?.removeEventListener('abort', abort)
        source?.destroy()
        stream?.destroy()
        await out.close()
      }
      progress?.((index + 1) / entries.length)
    }
    const after = await file.stat()
    const current = await lstat(path)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      current.ino !== before.ino ||
      current.mtimeMs !== before.mtimeMs ||
      current.isSymbolicLink()
    )
      fail('integrity')
    return skipped
  } catch (e) {
    if (created) await rm(destination, { recursive: true, force: true })
    throw e
  } finally {
    await file.close()
  }
}
