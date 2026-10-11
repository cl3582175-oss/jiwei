import { z } from 'zod'

export const FeedKind = z.enum(['rss', 'atom', 'arxiv', 'youtube', 'podcast', 'web'])
export const FeedSave = z.object({
  id: z.string().min(1).optional(),
  url: z.string().trim().min(1).max(4096),
  kind: FeedKind.optional(),
  title: z.string().trim().max(200).optional(),
  enabled: z.boolean().default(true),
  goalId: z.string().nullable().default(null)
})
export type FeedInput = z.input<typeof FeedSave>
export interface Feed {
  id: string
  kind: z.infer<typeof FeedKind>
  url: string
  title: string
  enabled: boolean
  goalId: string | null
  lastFetchedAt: number | null
  error: string | null
}
export const RelatedRef = z.object({ type: z.enum(['note', 'source']), id: z.string().min(1) })
export const PickScore = z.object({
  relevance: z.number().min(0).max(5),
  novelty: z.number().min(0).max(5),
  credibility: z.number().min(0).max(5),
  depth: z.number().min(0).max(5),
  minutes: z.number().int().min(1).max(240),
  reason: z.string().min(1).max(800),
  gap: z.string().max(500),
  related: z.array(RelatedRef).max(5),
  goalIds: z.array(z.string()).max(8),
  diverse: z.boolean(),
  news: z.boolean()
})
// 由主进程加上来源许可指纹，不接受模型提供的隐私许可。
export type DiscoveryScore = z.infer<typeof PickScore> & { privacySignature?: string }
export interface FeedItem {
  id: string
  feedId: string | null
  url: string
  title: string
  summary: string
  author: string | null
  publishedAt: number | null
  fetchedAt: number
  origin: 'feed' | 'search'
  status: 'new' | 'scored' | 'picked' | 'dismissed' | 'saved' | 'later'
  score: DiscoveryScore | null
  reason: string | null
  related: z.infer<typeof RelatedRef>[]
  gap: string | null
  minutes: number | null
  pickedAt: number | null
  laterAt: number | null
  audioUrl: string | null
  pdfUrl: string | null
  inboxId: string | null
  remedyId: string | null
}
export const DiscoverAct = z.object({
  itemId: z.string().min(1),
  action: z.enum(['read', 'save', 'later', 'dismiss']),
  reason: z.enum(['irrelevant', 'shallow', 'hard', 'untrusted']).optional()
})
export type DiscoverAction = z.infer<typeof DiscoverAct>
export const SearchProvider = z.enum(['bocha', 'tavily', 'brave'])
export type SearchService = z.infer<typeof SearchProvider>
export const SearchSave = z.object({ service: SearchProvider, key: z.string().max(4000).optional(), enabled: z.boolean() })
export interface SearchConnection {
  service: SearchService
  keySet: boolean
  enabled: boolean
}
export interface SearchResult {
  url: string
  title: string
  snippet: string
  publishedAt?: number
}
export interface DiscoveryStatus {
  date: string
  status: 'idle' | 'queued' | 'running' | 'ok' | 'budget' | 'error' | 'canceled'
  picked: number
  spent: number
  message: string | null
  dedupAvailable: boolean
}
export const PathDraft = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        question: z.string().min(1).max(500),
        objective: z.string().min(1).max(1000),
        resourceIds: z.array(z.string()).min(1).max(3)
      })
    )
    .min(4)
    .max(8)
})
export interface LearningPath {
  id: string
  noteId: string
  proposalId: string
  goalId: string
  steps: {
    title: string
    question: string
    objective: string
    resources: { id: string; title: string; url?: string; type: 'note' | 'source' | 'web' }[]
  }[]
  expiresAt: number
}
export interface PodcastScript {
  date: string
  paragraphs: string[]
  createdAt: number
}
export interface PodcastState {
  date: string
  status: 'idle' | 'queued' | 'running' | 'ok' | 'stale' | 'budget' | 'error' | 'canceled'
  script: PodcastScript | null
  message: string | null
}
