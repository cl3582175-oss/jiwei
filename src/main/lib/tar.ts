import { open, type FileHandle } from 'fs/promises'
import { basename } from 'path'

const BLOCK = 512
export const TAR_MAX_SIZE = 0o77777777777
export interface TarEntry {
  path: string
  size: number
  offset: number
  directory: boolean
}
export interface TarInput {
  path: string
  file?: string
  bytes?: Buffer
  directory?: boolean
}
export type Transfer = (bytes: number) => void

export function safeTarPath(path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((p) => p === '..' || p === '.' || !p)
  )
    throw new Error('备份包含不安全的文件路径')
  return path
}
function field(header: Buffer, at: number, length: number): string {
  const bytes = header.subarray(at, at + length),
    end = bytes.indexOf(0)
  return bytes.subarray(0, end < 0 ? length : end).toString('utf8')
}
function number(header: Buffer, at: number, length: number): number {
  const value = field(header, at, length).trim()
  if (!/^[0-7]+$/.test(value)) throw new Error('备份文件头已损坏')
  return parseInt(value, 8)
}
function octal(header: Buffer, at: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value.toString(8).length >= length)
    throw new Error('文件过大，ustar 不支持 8 GB 及以上的单个文件')
  header.write(value.toString(8).padStart(length - 1, '0') + '\0', at, length, 'ascii')
}
export function tarHeader(path: string, size: number, directory = false): Buffer {
  safeTarPath(path)
  const header = Buffer.alloc(BLOCK)
  let name = path,
    prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const cuts = [...path.matchAll(/\//g)].map((m) => m.index!).reverse()
    const cut = cuts.find((i) => Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100)
    if (cut === undefined) throw new Error(`备份中有过长的文件名：${basename(path)}`)
    prefix = path.slice(0, cut)
    name = path.slice(cut + 1)
  }
  header.write(name, 0, 100, 'utf8')
  header.write(prefix, 345, 155, 'utf8')
  octal(header, 100, 8, directory ? 0o700 : 0o600)
  octal(header, 108, 8, 0)
  octal(header, 116, 8, 0)
  octal(header, 124, 12, directory ? 0 : size)
  octal(header, 136, 12, Math.floor(Date.now() / 1000))
  header.fill(32, 148, 156)
  header[156] = directory ? 53 : 48
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2)
  const sum = header.reduce((n, b) => n + b, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}
async function readExact(handle: FileHandle, length: number, offset: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await handle.read(buffer, got, length - got, offset + got)
    if (!bytesRead) throw new Error('备份文件不完整')
    got += bytesRead
  }
  return buffer
}
export async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let at = 0
  while (at < bytes.length) at += (await handle.write(bytes, at, bytes.length - at)).bytesWritten
}
/** 流式读取索引：不接受链接、设备、扩展头、重复路径或不完整的结尾。 */
export async function readTar(file: string, signal?: AbortSignal): Promise<TarEntry[]> {
  const handle = await open(file, 'r'),
    entries: TarEntry[] = [],
    seen = new Set<string>()
  try {
    const { size } = await handle.stat()
    let at = 0
    while (at + BLOCK * 2 <= size) {
      signal?.throwIfAborted()
      const header = await readExact(handle, BLOCK, at)
      if (header.every((b) => b === 0)) {
        if (!(await readExact(handle, BLOCK, at + BLOCK)).every((b) => b === 0) || at + BLOCK * 2 !== size)
          throw new Error('备份文件结尾已损坏')
        return entries
      }
      const expected = number(header, 148, 8),
        copy = Buffer.from(header)
      copy.fill(32, 148, 156)
      if (copy.reduce((n, b) => n + b, 0) !== expected || field(header, 257, 6) !== 'ustar' || field(header, 263, 2) !== '00')
        throw new Error('备份文件头已损坏')
      const type = header[156],
        directory = type === 53
      if (type !== 48 && type !== 0 && !directory) throw new Error('备份包含不支持的链接或特殊文件')
      const prefix = field(header, 345, 155),
        path = safeTarPath((prefix ? prefix + '/' : '') + field(header, 0, 100))
      if (seen.has(path)) throw new Error('备份包含重复文件')
      seen.add(path)
      const length = number(header, 124, 12)
      if (length > TAR_MAX_SIZE || (directory && length !== 0)) throw new Error('备份文件大小无效')
      const offset = at + BLOCK
      entries.push({ path, size: length, offset, directory })
      if (entries.length > 1_000_000) throw new Error('备份中的文件数量过多')
      at = offset + Math.ceil(length / BLOCK) * BLOCK
    }
    throw new Error('备份文件不完整')
  } finally {
    await handle.close()
  }
}
export async function readTarBytes(file: string, entry: TarEntry, limit: number): Promise<Buffer> {
  if (entry.size > limit || entry.directory) throw new Error('备份清单过大或格式不正确')
  const handle = await open(file, 'r')
  try {
    return await readExact(handle, entry.size, entry.offset)
  } finally {
    await handle.close()
  }
}
/** 固定 1 MB 缓冲，支持取消与字节进度。 */
export async function copyRange(
  input: FileHandle,
  output: FileHandle | null,
  offset: number,
  size: number,
  signal?: AbortSignal,
  consume?: (bytes: Buffer) => void
): Promise<void> {
  const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size)))
  for (let at = 0; at < size;) {
    signal?.throwIfAborted()
    const wanted = Math.min(buffer.length, size - at),
      { bytesRead } = await input.read(buffer, 0, wanted, offset + at)
    if (!bytesRead) throw new Error('备份文件不完整')
    const bytes = buffer.subarray(0, bytesRead)
    if (output) await writeAll(output, bytes)
    consume?.(bytes)
    at += bytesRead
  }
}
export async function writeTar(file: string, entries: TarInput[], signal?: AbortSignal, progress?: Transfer): Promise<void> {
  const out = await open(file, 'wx', 0o600)
  try {
    const seen = new Set<string>()
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (seen.has(entry.path)) throw new Error('备份包含重复文件')
      seen.add(entry.path)
      const input = entry.file ? await open(entry.file, 'r') : null
      try {
        const size = input ? (await input.stat()).size : (entry.bytes?.length ?? 0)
        await writeAll(out, tarHeader(entry.path, size, entry.directory))
        if (input) await copyRange(input, out, 0, size, signal, (b) => progress?.(b.length))
        else if (entry.bytes) {
          await writeAll(out, entry.bytes)
          progress?.(entry.bytes.length)
        }
        await writeAll(out, Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK))
      } finally {
        await input?.close()
      }
    }
    await writeAll(out, Buffer.alloc(BLOCK * 2))
    await out.sync()
  } finally {
    await out.close()
  }
}
