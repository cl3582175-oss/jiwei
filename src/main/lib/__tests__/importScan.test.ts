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
  it('collects distinct same-named resources at their explicit relative paths before any filename fallback', async () => {
    const d = await fixture()
    await mkdir(join(d, 'attachments'))
    await writeFile(join(d, 'A.md'), '![](attachments/image.png) ![](image.png)')
    await writeFile(join(d, 'image.png'), 'root image')
    await writeFile(join(d, 'attachments/image.png'), 'nested image')
    const r = await scanLibrary([join(d, 'A.md')], [], () => {})
    expect(r.stats.attachments).toBe(2)
    expect(r.files.map((f) => f.relative)).toEqual(expect.arrayContaining(['image.png', 'attachments/image.png']))
    expect(r.files.find((f) => f.relative === 'image.png')!.hash).not.toBe(
      r.files.find((f) => f.relative === 'attachments/image.png')!.hash
    )
  })
  it('includes only explicitly referenced adjacent assets for selected Markdown files', async () => {
    const d = await fixture(),
      outside = await fixture()
    await mkdir(join(d, '附件'))
    await writeFile(join(d, 'A.md'), '# A\n![](附件/图.png) [材料](附件/材料.pdf) ![](逃出.png) ![](.secret.png)')
    await writeFile(join(d, 'B.md'), '# 未选择')
    await writeFile(join(d, '附件/图.png'), 'image fixture')
    await writeFile(join(d, '附件/材料.pdf'), 'document fixture')
    await writeFile(join(d, '.secret.png'), 'hidden')
    await writeFile(join(outside, '逃出.png'), 'outside')
    await symlink(join(outside, '逃出.png'), join(d, '逃出.png'))
    const r = await scanLibrary([join(d, 'A.md')], [], () => {})
    expect(r.entries.map((e) => e.path)).toEqual(['A.md'])
    expect(r.stats.attachments).toBe(2)
    expect(r.files.map((f) => f.relative)).toEqual(expect.arrayContaining(['附件/图.png', '附件/材料.pdf']))
    expect(r.files.some((f) => ['B.md', '逃出.png', '.secret.png'].includes(f.relative))).toBe(false)
    expect(r.issues).toContainEqual({ path: '逃出.png', code: 'symlink' })
  })
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
