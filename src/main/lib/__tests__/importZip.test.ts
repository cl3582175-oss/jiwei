import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractSafeZip } from '../../services/importer/zip'
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function attempt(bytes: Buffer) {
  const d = await mkdtemp(join(tmpdir(), 'jiwei-zip-'))
  dirs.push(d)
  const p = join(d, 'input.zip')
  await writeFile(p, bytes)
  const out = join(d, 'out')
  await extractSafeZip(p, out)
  return out
}
async function archive(name = 'safe.md', content = 'original', permissions?: number): Promise<Buffer> {
  return new JSZip()
    .file(name, content, permissions ? { unixPermissions: permissions } : {})
    .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' })
}
describe('Notion archive boundary', () => {
  it('extracts authored Unicode names and verifies real content', async () => {
    const out = await attempt(await archive('子目录/中文.md', '# 中文'))
    expect(await readFile(join(out, '子目录/中文.md'), 'utf8')).toBe('# 中文')
  })
  it.each(['../escape.md', '/absolute.md', 'C:/absolute.md', 'a/../../escape.md', 'a\\..\\escape.md'])(
    'rejects original raw archive path %s',
    async (path) => {
      await expect(attempt(await archive(path))).rejects.toThrow()
    }
  )
  it('rejects symlinks and dangerous raw names even when Unicode extras claim a safe name', async () => {
    await expect(attempt(await archive('link', '../outside', 0o120777))).rejects.toThrow()
    const zip = new JSZip().file('安全.md', 'original')
    const bytes = await zip.generateAsync({ type: 'nodebuffer', encodeFileName: () => '../x.md' })
    await expect(attempt(bytes)).rejects.toThrow()
  })
  it('rejects local-header paths that disagree with a safe central directory', async () => {
    const b = await archive()
    Buffer.from('../x.md').copy(b, 30)
    await expect(attempt(b)).rejects.toThrow()
  })
  it('rejects declared sizes beyond 2 GB, file counts beyond 50000, and false inflation sizes', async () => {
    const large = await archive()
    const central = large.indexOf(Buffer.from('504b0102', 'hex'))
    large.writeUInt32LE(0x80000001, central + 24)
    await expect(attempt(large)).rejects.toThrow()
    const count = await archive()
    const eocd = count.lastIndexOf(Buffer.from('504b0506', 'hex'))
    count.writeUInt16LE(50001, eocd + 10)
    count.writeUInt16LE(50001, eocd + 8)
    await expect(attempt(count)).rejects.toThrow()
    const bomb = await archive('safe.md', 'x'.repeat(1024 * 1024))
    const cd = bomb.indexOf(Buffer.from('504b0102', 'hex'))
    bomb.writeUInt32LE(1, cd + 24)
    bomb.writeUInt32LE(1, 22)
    await expect(attempt(bomb)).rejects.toThrow()
  })
})
