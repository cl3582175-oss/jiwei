import { z } from 'zod'
import type { DocJSON } from './types'
export type ImportKind = 'markdown' | 'obsidian' | 'notion'
export type ImportIssueCode =
  | 'unsupported'
  | 'too-large'
  | 'symlink'
  | 'unreadable'
  | 'encoding'
  | 'broken-link'
  | 'ambiguous'
  | 'note-limit'
  | 'ignored'
  | 'invalid-frontmatter'
  | 'invalid-date'
  | 'remote-image'
  | 'invalid-mermaid-size'
  | 'changed'
  | 'excluded-target'
  | 'interrupted'
  | 'notion-missing'
  | 'extra-columns'
  | 'csv-columns'
  | 'long-title'
  | 'tag-limit'
export interface ImportIssue {
  path: string
  code: ImportIssueCode
  count?: number
}
export interface ImportEntry {
  path: string
  title: string
  hash: string
  tags: string[]
  aliases: string[]
  rows: number
  tasks: number
  cueRows?: number
  cueChars?: number
  status: 'new' | 'unchanged' | 'changed'
  previousNoteId?: string
}
export interface ImportScan {
  id: string
  kind: ImportKind
  label: string
  status: 'queued' | 'scanning' | 'ready' | 'canceled' | 'failed'
  progress: number
  jobId: string
  entries: ImportEntry[]
  issues: ImportIssue[]
  stats: { notes: number; attachments: number; tags: number; links: number; tasks: number }
  error?: string
}
export interface ImportItem {
  path: string
  status: 'imported' | 'skipped' | 'failed'
  noteId?: string
  message?: string
}
export interface ImportRun {
  id: string
  scanId: string
  label: string
  kind: ImportKind
  status: 'queued' | 'running' | 'canceling' | 'done' | 'canceled' | 'failed'
  jobId: string
  progress: number
  items: ImportItem[]
  issues: ImportIssue[]
  sourceIds: string[]
  assetIds: string[]
  categoryIds: string[]
  cueJobIds: string[]
  tasks: number
  createdAt: number
  undoneAt?: number
  error?: string
}
export interface ImportPreview {
  title: string
  doc: DocJSON
  embeds: Record<string, { kind: string; data: unknown }>
}
export const ImportOptionsSchema = z
  .object({
    paths: z.array(z.string().min(1).max(4096)).min(1).max(5000),
    categoryId: z.string().max(64).nullable().default(null),
    newCategoryName: z.string().trim().min(1).max(200),
    preserveFolders: z.boolean().default(true),
    tags: z.boolean().default(true),
    aiExcluded: z.boolean().default(false),
    aiCues: z.boolean().default(false),
    importChanged: z.boolean().default(false)
  })
  .refine((o) => !o.aiExcluded || !o.aiCues, 'Private imports cannot use AI')
export type ImportOptions = z.infer<typeof ImportOptionsSchema>
export interface ImportEstimate {
  calls: number
  cost: number | null
  model: string | null
  available: boolean
}
