import { tr } from './messages'
import { ManifestSchema, type BackupManifest } from '@shared/backup'
import { safeTarPath, type TarEntry } from './tar'

export const fileCategory = (path: string): string =>
  path.startsWith('assets/') ? tr('素材', 'Files') : path.startsWith('recordings/') ? tr('录音', 'Recordings') : path.startsWith('profile/') ? tr('个人档案', 'Profile') : tr('知识库数据库', 'Vault database')
export function parseBackupManifest(raw: unknown, knowledgeVersion: number, profileVersion: number, legacyVersion: number): BackupManifest {
  const parsed = ManifestSchema.safeParse(raw)
  if (!parsed.success) throw new Error(tr('备份清单无效或已损坏', 'The backup manifest is invalid or damaged'))
  const m = parsed.data
  if (m.knowledgeVersion > knowledgeVersion || m.profileVersion > profileVersion || m.profileLegacyVersion > legacyVersion)
    throw new Error(tr('这份备份来自更新版本，请先升级积微', 'This backup comes from a newer version. Update Jiwei first.'))
  const seen = new Set<string>()
  for (const file of m.files) {
    safeTarPath(file.path)
    if (
      seen.has(file.path) ||
      !/^(jiwei\.db|profile\/memory\.db|assets\/[\w./-]+|recordings\/[a-f0-9-]{36}\/(?:manifest\.json|(?:mix|mic|system)(?:-\d{6})?\.webm(?:\.enc)?))$/i.test(
        file.path
      )
    )
      throw new Error(tr('备份清单含有不支持或重复的文件', 'The backup manifest lists unsupported or duplicate files'))
    seen.add(file.path)
  }
  if (
    !seen.has('jiwei.db') ||
    m.includeProfile !== seen.has('profile/memory.db') ||
    m.totalSize !== m.files.reduce((n, f) => n + f.size, 0)
  )
    throw new Error(tr('备份清单不完整', 'The backup manifest is incomplete'))
  return m
}
export function validateArchiveEntries(entries: TarEntry[], manifest: BackupManifest): void {
  if (entries[0]?.path !== 'manifest.json' || entries[0].directory) throw new Error(tr('备份的第一个条目必须是清单', 'The first entry of the backup must be the manifest'))
  const listed = new Map(manifest.files.map((f) => [f.path, f]))
  if (entries.length !== listed.size + 1) throw new Error(tr('备份文件缺失或包含未列入清单的内容', 'Backup files are missing or include unlisted content'))
  for (const entry of entries.slice(1)) {
    const file = listed.get(entry.path)
    if (!file || entry.directory || file.size !== entry.size) throw new Error(tr(`${fileCategory(entry.path)}不完整或已损坏`, `${fileCategory(entry.path)} is incomplete or damaged`))
  }
}
