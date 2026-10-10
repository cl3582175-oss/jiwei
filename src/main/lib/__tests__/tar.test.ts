import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readTar, readTarBytes, safeTarPath, tarHeader, writeTar } from '../tar'

const roots: string[] = []
const dir = async (): Promise<string> => { const path = await mkdtemp(join(tmpdir(), 'jiwei-tar-')); roots.push(path); return path }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('streaming ustar', () => {
  it('round trips empty files, directories and UTF-8 prefix paths', async () => {
    const file = join(await dir(), 'backup.tar'), long = 'assets/' + '资料'.repeat(24) + '/document.pdf'
    await writeTar(file, [{ path: 'manifest.json', bytes: Buffer.from('{}') }, { path: 'empty', bytes: Buffer.alloc(0) }, { path: 'directory', directory: true }, { path: long, bytes: Buffer.from('正文') }])
    const entries = await readTar(file)
    expect(entries.map(e => e.path)).toEqual(['manifest.json', 'empty', 'directory', long])
    expect((await readTarBytes(file, entries[3], 100)).toString()).toBe('正文')
    expect(await readTarBytes(file, entries[1], 100)).toEqual(Buffer.alloc(0))
  })
  it.each(['../outside', 'a/../outside', '/absolute', 'C:/absolute', 'a\\b', 'a//b', 'a/./b'])('rejects unsafe path %s', path => { expect(() => safeTarPath(path)).toThrow() })
  it('rejects 8 GiB and overlong names before writing', () => { expect(() => tarHeader('large', 2 ** 33)).toThrow(/8 GB/); expect(() => tarHeader('x'.repeat(101), 0)).toThrow() })
  it('rejects links, special files, duplicate paths, truncated endings and corrupt headers', async () => {
    const file = join(await dir(), 'unsafe.tar')
    for (const type of ['1', '2', '3', '4', '6', 'x', 'L']) {
      const header = tarHeader('unsafe', 0); header[156] = type.charCodeAt(0); header.fill(32, 148, 156)
      header.write(header.reduce((n, b) => n + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8)
      await writeFile(file, Buffer.concat([header, Buffer.alloc(1024)])); await expect(readTar(file)).rejects.toThrow()
    }
    await writeFile(file, Buffer.concat([tarHeader('file', 0), tarHeader('file', 0), Buffer.alloc(1024)])); await expect(readTar(file)).rejects.toThrow(/重复/)
    await writeFile(file, Buffer.concat([tarHeader('file', 0), Buffer.alloc(512)])); await expect(readTar(file)).rejects.toThrow(/不完整/)
    const bad = tarHeader('file', 0); bad[100] ^= 1; await writeFile(file, Buffer.concat([bad, Buffer.alloc(1024)])); await expect(readTar(file)).rejects.toThrow(/损坏/)
  })
  it('uses a regular stream and honors cancellation', async () => {
    const root = await dir(), from = join(root, 'source'), out = join(root, 'stream.tar'), bytes = Buffer.alloc(3 * 1024 * 1024, 19)
    await writeFile(from, bytes); const controller = new AbortController()
    await expect(writeTar(out, [{ path: 'source', file: from }], controller.signal, () => controller.abort())).rejects.toThrow()
    expect((await readFile(out)).length).toBeLessThan(bytes.length)
  })
})
