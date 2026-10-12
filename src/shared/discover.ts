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
  pluginId?: string | null
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
  /** 本次评估过的候选条数（用于“看过了但没有合适的”的空状态） */
  considered?: number
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
  /** 双人对谈时每段的说话人（A 主讲、B 提问）；单人讲解为空 */
  speakers?: ('A' | 'B')[]
  /** AI 语音合成的音频（jiwei://podcast/…），按顺序播放；p 为所属段落。为空时用系统语音朗读 */
  audio?: { p: number; url: string }[] | null
  /** 合成音频所用的语音说明（如“通义 · 芊悦 / 晨煦”） */
  voiceLabel?: string | null
}

/* ——— 播客语音（v0.8 审查后加入 AI 语音合成） ——— */

export type TtsEngine = 'qwen' | 'openai'
export interface TtsProvider {
  providerId: string
  name: string
  engine: TtsEngine
}
export const TTS_MODELS: Record<TtsEngine, string> = { qwen: 'qwen3-tts-flash', openai: 'gpt-4o-mini-tts' }
/** 预置音色：label 为中文名 / 英文名 */
export const TTS_VOICES: Record<TtsEngine, { id: string; zh: string; en: string }[]> = {
  qwen: [
    { id: 'Cherry', zh: '芊悦（女声，亲切）', en: 'Cherry (female, warm)' },
    { id: 'Ethan', zh: '晨煦（男声，沉稳）', en: 'Ethan (male, steady)' },
    { id: 'Serena', zh: '苏瑶（女声，温柔）', en: 'Serena (female, gentle)' },
    { id: 'Chelsie', zh: '千雪（女声，清亮）', en: 'Chelsie (female, bright)' }
  ],
  openai: [
    { id: 'marin', zh: 'Marin（女声）', en: 'Marin (female)' },
    { id: 'cedar', zh: 'Cedar（男声）', en: 'Cedar (male)' },
    { id: 'coral', zh: 'Coral（女声）', en: 'Coral (female)' },
    { id: 'ash', zh: 'Ash（男声）', en: 'Ash (male)' }
  ]
}
/**
 * 本机语音（ZipVoice）的预置声音：语气与音色跟随一段参考录音。
 * 参考录音取自 AISHELL-3（Apache-2.0，北京希尔贝壳科技），首次使用时与模型一起下载。
 */
export const LOCAL_VOICES: { id: string; zh: string; en: string }[] = [
  // 顺序即默认搭配：双人对谈默认第一、二个（一女一男，便于分辨）
  { id: 'f1', zh: '明亮女声', en: 'Bright female' },
  { id: 'm1', zh: '沉稳男声', en: 'Steady male' },
  { id: 'f2', zh: '温和女声', en: 'Gentle female' },
  { id: 'm2', zh: '清朗男声', en: 'Clear male' }
]
export interface LocalSpeechStatus {
  state: 'missing' | 'downloading' | 'ready' | 'error'
  progress: number
  /** 已占用 / 需要下载的字节数 */
  bytes: number
  speed: number | null
  message: string | null
}
export const PodcastVoiceSchema = z.object({
  /** system：系统语音（免费、离线）；local：本机 AI 语音（免费、需下载模型）；ai：服务商的语音合成 */
  engine: z.enum(['system', 'local', 'ai']),
  providerId: z.string().max(64).nullable(),
  /** 主讲的音色、对谈时提问者的音色 */
  voiceA: z.string().max(40).nullable(),
  voiceB: z.string().max(40).nullable(),
  /** solo：一人讲解；dialogue：两人对谈（只在 AI 语音下有效） */
  style: z.enum(['solo', 'dialogue'])
})
export type PodcastVoice = z.infer<typeof PodcastVoiceSchema>
export const DEFAULT_PODCAST_VOICE: PodcastVoice = { engine: 'system', providerId: null, voiceA: null, voiceB: null, style: 'solo' }
export interface PodcastState {
  date: string
  status: 'idle' | 'queued' | 'running' | 'ok' | 'stale' | 'budget' | 'error' | 'canceled'
  script: PodcastScript | null
  message: string | null
}
