import { z } from 'zod'

export const ExternalBackupSchema = z.object({
  path: z.string().min(1).max(4096).nullable(),
  frequency: z.enum(['daily', 'weekly']),
  keep: z.number().int().min(1).max(100)
})
export type ExternalBackup = z.infer<typeof ExternalBackupSchema>
export interface SafetyProgress {
  kind: string
  state: 'idle' | 'running' | 'done' | 'canceled' | 'failed'
  processed: number
  total: number
  startedAt: number
  remainingSeconds: number | null
  message: string
}
export const ManifestSchema = z.object({
  format: z.literal(1),
  appVersion: z.string().max(80),
  knowledgeVersion: z.number().int().nonnegative(),
  profileVersion: z.number().int().nonnegative(),
  profileLegacyVersion: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  device: z.string().max(300),
  vault: z.string().max(300),
  kind: z.enum(['auto', 'manual', 'pre-restore']),
  notes: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  recordings: z.number().int().nonnegative(),
  assets: z.number().int().nonnegative(),
  totalSize: z.number().int().nonnegative(),
  includeProfile: z.boolean(),
  encryptedRecordings: z.boolean(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(256),
        size: z.number().int().min(0).max(0o77777777777),
        sha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
    )
    .max(1_000_000)
})
export type BackupManifest = z.infer<typeof ManifestSchema>
export interface BackupPreview {
  token: string
  manifest: BackupManifest
  profileEmpty: boolean
  databaseOnly: boolean
}
export const RestoreSchema = z.object({
  token: z.string().uuid(),
  mode: z.enum(['new', 'replace']),
  includeProfile: z.boolean(),
  confirmed: z.boolean().default(false)
})
export interface BackupStatus {
  progress: SafetyProgress
  localAt: number | null
  externalAt: number | null
  externalUnavailable: boolean
  external: ExternalBackup
  bytes: number
  notice: string | null
  restoredVault: { id: string; name: string; path: string } | null
}
export interface RecordingCryptoStatus {
  available: boolean
  reason: string | null
  encryption: 'on' | 'off' | 'unset'
  unlocked: boolean
  progress: SafetyProgress
}
