import { z } from 'zod'
import type { Conversation } from './types'
import type { Readiness } from './readiness'
const name = z.string().trim().min(1).max(60)
export const ProjectCreateSchema = z.object({
  name,
  color: z.string().max(40).nullable().optional(),
  instructions: z.string().max(4000).default(''),
  memory: z.enum(['default', 'project']).default('default'),
  libraryScope: z.enum(['all', 'none']).default('all')
})
export const ProjectUpdateSchema = z.object({
  name: name.optional(),
  color: z.string().max(40).nullable().optional(),
  instructions: z.string().max(4000).optional(),
  memory: z.enum(['default', 'project']).optional(),
  libraryScope: z.enum(['all', 'none']).optional(),
  pinned: z.boolean().optional(),
  promoteMemories: z.boolean().optional()
})
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>
export interface ChatProject {
  id: string
  name: string
  color: string | null
  instructions: string
  memory: 'default' | 'project'
  libraryScope: 'all' | 'none'
  pinned: boolean
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  memoryCount: number
}
export type ChatProjectConversation = Conversation & { summary: string; lastMessageAt: number }
export interface ChatSearchHit {
  conversationId: string
  title: string
  snippet: string
  messageId: string | null
  projectId: string | null
  projectName: string | null
  lastMessageAt: number
}
export interface ChatProjectSource {
  projectId: string
  itemType: 'note' | 'source'
  itemId: string
  origin: 'upload' | 'library' | 'text' | 'url'
  createdAt: number
  title: string
  kind: string
  readiness: Readiness | null
  space: 'library' | 'attachment' | null
  available: boolean
}
export const ProjectSourcesInputSchema = z.discriminatedUnion('origin', [
  z.object({ origin: z.literal('upload'), paths: z.array(z.string().min(1)).max(50).optional() }),
  z.object({
    origin: z.literal('library'),
    notes: z.array(z.string().min(1).max(64)).max(50).default([]),
    sources: z.array(z.string().min(1).max(64)).max(50).default([])
  }),
  z.object({ origin: z.literal('text'), title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(1000000) }),
  z.object({ origin: z.literal('url'), url: z.string().url().max(4000) })
])
export type ProjectSourcesInput = z.infer<typeof ProjectSourcesInputSchema>
