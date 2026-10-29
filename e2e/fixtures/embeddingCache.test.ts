import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareEmbeddingInstallCache } from './embeddingCache'

const directories: string[] = []
const artifacts = [
  { file: 'model.gguf', path: 'model.gguf', size: 13, sha256: '21249a290a4255a0f3ee6685ff7933bffa241c3e35bb13a52dc0c7a679bed3b2' },
  { file: 'runtime.tar.gz', path: '.llama-downloads/runtime.tar.gz', size: 15, sha256: 'b7285ea542f1df1905bb195b8d8a147ae62ecaf006b89dabe1c0aabb1cffe2eb' }
]

function source(): string {
  const path = mkdtempSync(join(tmpdir(), 'jiwei-embedding-artifacts-'))
  directories.push(path)
  writeFileSync(join(path, 'model.gguf'), 'model fixture')
  writeFileSync(join(path, 'runtime.tar.gz'), 'runtime fixture')
  return path
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('copies only verified model and archive bytes into an independently writable cache before launch', async () => {
  const from = source()
  writeFileSync(join(from, 'llama-server.pid'), '123')
  mkdirSync(join(from, 'llama-b11491'))
  writeFileSync(join(from, 'llama-b11491', '.lease-123'), '123')
  const appData = await prepareEmbeddingInstallCache(from, artifacts)
  directories.push(appData)
  const target = join(appData, 'jiwei-models')
  expect(readdirSync(target).sort()).toEqual(['.llama-downloads', 'model.gguf'])
  expect(readFileSync(join(target, '.llama-downloads/runtime.tar.gz'), 'utf8')).toBe('runtime fixture')
  expect(existsSync(join(target, 'llama-b11491'))).toBe(false)
  writeFileSync(join(target, 'model.gguf'), 'changed copy')
  expect(readFileSync(join(from, 'model.gguf'), 'utf8')).toBe('model fixture')
})

it('rejects corrupt copied artifacts instead of making installation appear available', async () => {
  const from = source()
  writeFileSync(join(from, 'runtime.tar.gz'), 'corrupt fixture')
  await expect(prepareEmbeddingInstallCache(from, artifacts)).rejects.toThrow(/sha256/)
})

it('rejects symlink artifact sources instead of cloning runtime state', async () => {
  const from = source()
  rmSync(join(from, 'model.gguf'))
  symlinkSync('runtime.tar.gz', join(from, 'model.gguf'))
  await expect(prepareEmbeddingInstallCache(from, artifacts)).rejects.toThrow(/regular file/)
})
