import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'

const modulePath = new URL('../../../../scripts/release-checksums.mjs', import.meta.url).href
const { checksumArtifacts } = (await import(modulePath)) as { checksumArtifacts(root: string): Promise<{ name: string; sha256: string }[]> }

it('hashes installer bytes and excludes metadata from the installer list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jiwei-release-hashes-'))
  try {
    await writeFile(join(directory, 'Jiwei-fixture-win.exe'), 'abc')
    await writeFile(join(directory, 'latest.yml'), 'metadata')
    expect(await checksumArtifacts(directory)).toEqual([
      { name: 'Jiwei-fixture-win.exe', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('fails an empty release instead of producing an empty success manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jiwei-release-empty-'))
  try {
    await expect(checksumArtifacts(directory)).rejects.toThrow(/No installers/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
