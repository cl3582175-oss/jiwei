import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareVersions, updateMode } from '@shared/updates'
import { upgradeSnapshot } from '../updateBackup'
import { verifyUpdateSha512 } from '../updateIntegrity'

describe('update decisions and integrity', () => {
  it.each([
    ['1.0.10', '1.0.2', 1],
    ['0.9.0', '0.9.0', 0],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0+build.2', '1.0.0+build.1', 0]
  ])('compares %s against %s without lexical version mistakes', (a, b, want) =>
    expect(compareVersions(a as string, b as string)).toBe(want)
  )
  it.each([
    [{ platform: 'darwin', packaged: true, signed: false, appImage: false }, 'mac-manual'],
    [{ platform: 'darwin', packaged: true, signed: true, appImage: false }, 'automatic'],
    [{ platform: 'win32', packaged: true, signed: false, appImage: false }, 'automatic'],
    [{ platform: 'linux', packaged: true, signed: false, appImage: true }, 'automatic'],
    [{ platform: 'linux', packaged: true, signed: false, appImage: false }, 'download-page'],
    [{ platform: 'darwin', packaged: false, signed: false, appImage: false }, 'disabled']
  ])('selects the supported platform path', (input, want) => expect(updateMode(input as Parameters<typeof updateMode>[0])).toBe(want))
  it('verifies real bytes, rejecting a SHA-512 mismatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jiwei-update-integrity-'))
    try {
      const file = join(directory, 'installer.dmg')
      await writeFile(file, 'abc')
      await expect(
        verifyUpdateSha512(file, '3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==')
      ).resolves.toBeUndefined()
      await expect(
        verifyUpdateSha512(file, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==')
      ).rejects.toThrow(/checksum/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('retains only the latest two successful upgrade snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jiwei-upgrade-backups-'))
    try {
      for (let i = 1; i <= 3; i++)
        await upgradeSnapshot({
          from: `0.9.${i}`,
          to: `0.9.${i + 1}`,
          directory,
          now: i,
          backup: (path) => writeFile(path, `snapshot ${i}`)
        })
      const names = (await readdir(directory)).sort()
      expect(names).toHaveLength(2)
      expect(await Promise.all(names.map((n) => readFile(join(directory, n), 'utf8')))).toEqual(['snapshot 2', 'snapshot 3'])
      const failure = await upgradeSnapshot({
        from: '0.9.4',
        to: '0.9.5',
        directory,
        now: 4,
        backup: async () => {
          throw new Error('disk full')
        }
      })
      expect(failure?.backupFailed).toBe(true)
      expect(await readdir(directory)).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('does not snapshot a downgrade or unchanged version', async () => {
    let calls = 0
    expect(
      await upgradeSnapshot({
        from: '1.0.0',
        to: '0.9.0',
        directory: '/unused',
        backup: async () => {
          calls++
        }
      })
    ).toBeNull()
    expect(calls).toBe(0)
  })
})
