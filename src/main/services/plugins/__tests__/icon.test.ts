import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { pluginIcon } from '../icon'
let root: string
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0mQAAAAASUVORK5CYII=', 'base64')
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jiwei-icon-'))
  await mkdir(join(root, 'jiwei'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
it('returns only bounded PNG data, with no filesystem authority', async () => {
  await writeFile(join(root, 'jiwei/icon.png'), png)
  expect(await pluginIcon(root)).toBe(`data:image/png;base64,${png.toString('base64')}`)
})
it('ignores missing, oversized, non-PNG and oversized dimensions', async () => {
  expect(await pluginIcon(root)).toBeUndefined()
  for (const data of [
    Buffer.alloc(102401),
    Buffer.from('<svg>bad</svg>'),
    (() => {
      const data = Buffer.from(png)
      data.writeUInt32BE(257, 16)
      return data
    })()
  ]) {
    await writeFile(join(root, 'jiwei/icon.png'), data)
    expect(await pluginIcon(root)).toBeUndefined()
  }
})
it('does not follow icon symlinks', async () => {
  await writeFile(join(root, 'outside.png'), png)
  await symlink(join(root, 'outside.png'), join(root, 'jiwei/icon.png'))
  expect(await pluginIcon(root)).toBeUndefined()
})
