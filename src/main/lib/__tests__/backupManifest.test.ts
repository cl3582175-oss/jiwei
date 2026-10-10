import { it, expect } from 'vitest'
import { parseBackupManifest, validateArchiveEntries } from '../backupManifest'
import type { BackupManifest } from '@shared/backup'
const manifest: BackupManifest = { format: 1, appVersion: '0.6.5', knowledgeVersion: 18, profileVersion: 0, profileLegacyVersion: 0, createdAt: Date.now(), device: 'test', vault: 'test', kind: 'manual', notes: 0, sources: 0, recordings: 0, assets: 0, totalSize: 100, includeProfile: false, encryptedRecordings: false, files: [{ path: 'jiwei.db', size: 100, sha256: 'a'.repeat(64) }] }
it('admits older versions and rejects newer versions and unsafe/missing/duplicate files', () => {
  expect(parseBackupManifest(manifest, 18, 2, 2)).toEqual(manifest)
  expect(() => parseBackupManifest(manifest, 17, 2, 2)).toThrow(/升级/)
  expect(() => parseBackupManifest({ ...manifest, files: [] }, 18, 2, 2)).toThrow(/不完整/)
  expect(() => parseBackupManifest({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: 'assets/../../escape' }] }, 18, 2, 2)).toThrow(/不安全/)
  expect(() => parseBackupManifest({ ...manifest, files: [...manifest.files, ...manifest.files] }, 18, 2, 2)).toThrow(/重复/)
})
it('requires exact archive membership and sizes', () => {
  const entries = [{ path: 'manifest.json', size: 500, offset: 512, directory: false }, { path: 'jiwei.db', size: 100, offset: 1536, directory: false }]
  expect(() => validateArchiveEntries(entries, manifest)).not.toThrow()
  expect(() => validateArchiveEntries(entries.slice(0, 1), manifest)).toThrow(/缺失/)
  expect(() => validateArchiveEntries([entries[0], { ...entries[1], size: 99 }], manifest)).toThrow(/损坏/)
})
