import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import asar from '@electron/asar'
import { afterEach, it, expect } from 'vitest'

const modulePath = new URL('../../../../scripts/release-privacy.mjs', import.meta.url).href
const { inspectArchive, inspectReleaseDirectory } = (await import(modulePath)) as {
  inspectArchive(path: string): { entries: number; applicationFilesScanned: number }
  inspectReleaseDirectory(path: string): Promise<unknown[]>
}
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function archive(extra: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jiwei-release-privacy-'))
  directories.push(directory)
  const source = join(directory, 'source')
  const files = {
    'package.json': '{"name":"jiwei"}',
    'out/main/index.js': 'const setting = "OPENAI_API_KEY"',
    'out/renderer/index.html': '<html></html>',
    ...extra
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(source, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  const destination = join(directory, 'app.asar')
  await asar.createPackage(source, destination)
  return destination
}

it('accepts runtime files and environment variable names without treating names as secrets', async () => {
  expect(inspectArchive(await archive()).applicationFilesScanned).toBe(3)
})

it('rejects a packed local Spec Kit pointer', async () => {
  const path = await archive({ '.specify/feature.json': '{"feature_directory":"private"}' })
  expect(() => inspectArchive(path)).toThrow(/private-development-file/)
})

it('rejects a credential in compiled code without including its value in diagnostics', async () => {
  const secret = 'gh' + 'p_' + 'x'.repeat(36)
  const path = await archive({ 'out/main/index.js': JSON.stringify(secret) })
  let diagnostic = ''
  try {
    inspectArchive(path)
  } catch (error) {
    diagnostic = String(error)
  }
  expect(diagnostic).toContain('github-token')
  expect(diagnostic).not.toContain(secret)
})

it('rejects personal project paths in compiled code', async () => {
  const path = await archive({ 'out/main/index.js': JSON.stringify('/Users/' + 'private-user/Projects/notes/') })
  expect(() => inspectArchive(path)).toThrow(/personal-home-path/)
})

it('rejects a build directory with no application archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jiwei-release-empty-'))
  directories.push(directory)
  await expect(inspectReleaseDirectory(directory)).rejects.toThrow(/application archives/)
})
