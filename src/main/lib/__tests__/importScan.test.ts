import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { scanLibrary, readChecked } from '../../services/importer/scan'
const dirs: string[] = []
async function fixture(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'jiwei-import-unit-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
describe('library scan boundary and preview', () => {
  it('recognizes Obsidian, skips hidden data, reports unsupported files and resolves references', async () => {
    const d = await fixture()
    await mkdir(join(d, '.obsidian'))
    await mkdir(join(d, '图'))
    await mkdir(join(d, '子目录'))
    await writeFile(join(d, '.obsidian/app.json'), '{"attachmentFolderPath":"图"}')
    await writeFile(join(d, '.secret.md'), '# 隐藏')
    await writeFile(join(d, '入口.md'), '# 入口\n\n[[目标]] ![[图.png]] [[不存在]] #标签')
    await writeFile(join(d, '子目录/目标.md'), '---\naliases: [目标]\n---\n# 真标题')
    await writeFile(join(d, '图/图.png'), 'fixture')
    await writeFile(join(d, '画布.canvas'), '{}')
    const r = await scanLibrary([d], [], () => {})
    expect(r.kind).toBe('obsidian')
    expect(r.entries.map((x) => x.path)).toEqual(['入口.md', '子目录/目标.md'])
    expect(r.stats).toEqual({ notes: 2, attachments: 1, tags: 1, links: 2, tasks: 0 })
    expect(r.issues).toContainEqual({ path: '入口.md', code: 'broken-link', count: 1 })
    expect(r.issues).toContainEqual({ path: '画布.canvas', code: 'unsupported' })
  })
  it('rejects symlinks and oversized files, and refuses a source changed after preview', async () => {
    const d = await fixture(),
      other = await fixture()
    await writeFile(join(other, 'outside.md'), 'outside')
    await symlink(join(other, 'outside.md'), join(d, 'escape.md'))
    await writeFile(join(d, '大.md'), 'a'.repeat(5 * 1024 * 1024 + 1))
    await writeFile(join(d, '正常.md'), '# 原文')
    const r = await scanLibrary([d], [], () => {})
    expect(r.entries).toHaveLength(1)
    expect(r.issues).toContainEqual({ path: 'escape.md', code: 'symlink' })
    expect(r.issues).toContainEqual({ path: '大.md', code: 'too-large' })
    const f = r.files.find((x) => x.relative === '正常.md')!
    await writeFile(join(d, '正常.md'), '# 改动')
    await expect(readChecked(r, f)).rejects.toThrow('changed')
  })
  it('reports unchanged and changed hashes without treating a deleted note as imported', async () => {
    const d = await fixture()
    await writeFile(join(d, 'A.md'), 'A')
    await writeFile(join(d, 'B.md'), 'B')
    const first = await scanLibrary([d], [], () => {})
    const history = first.entries.map((e) => ({ rootHash: first.rootHash, path: e.path, hash: e.hash, noteId: `id-${e.path}` }))
    await writeFile(join(d, 'B.md'), 'B changed')
    const second = await scanLibrary([d], history, () => {})
    expect(second.entries.map((e) => e.status)).toEqual(['unchanged', 'changed'])
    const deleted = await scanLibrary([d], [], () => {})
    expect(deleted.entries.every((e) => e.status === 'new')).toBe(true)
  })
})
