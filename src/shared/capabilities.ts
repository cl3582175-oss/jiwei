import {
  ProjectCreateSchema,
  ProjectUpdateSchema,
  type ChatProject,
  type ChatProjectConversation,
  type ChatSearchHit
} from './chatProjects'
import type { Readiness } from './readiness'
import { RELATIONS } from './graphRelations'
import { AnimationSchema } from './manim'
import { BACKEND_IDS, BackendSaveSchema, WebModeSchema, type RetrievalStatus, type RetrievalUsage, type WebPageView } from './retrieval'
import {
  MarketInputSchema,
  MarketNameSchema,
  type PluginMarketInfo,
  type PluginCatalogCard,
  type PluginDetection,
  type PluginDetails,
  type RoleCatalogCard,
  type RoleBatchPreview,
  type RoleBatchRecovery,
  type RoleStarters,
  type PluginStarter,
  RoleBatchSelections
} from './plugins'
import {
  PluginInspectSource,
  PluginConfigValues,
  PluginConfirmOptions,
  PluginUninstallOptions,
  type PluginInfo,
  type PluginPreview,
  type PluginRegistryItem,
  type PluginTemplate,
  type PluginFramework,
  type PluginRecipe
} from './plugins'
import { CaptureRectSchema, BrowserCaptureEntriesSchema, type BrowserCaptureFrame, type BrowserCaptureResult } from './browserCapture'
import { CaptureActionSchema } from './capture'
import { TaskSave, type AiTask, type TaskRun, type TaskToolInfo, type TaskInput } from './tasks'
import type { TaskRecipe } from './taskRecipes'
import { MailSave, type MailAccount } from './mail'
import {
  FeedSave,
  DiscoverAct,
  SearchSave,
  SearchProvider,
  type Feed,
  type FeedItem,
  type DiscoveryStatus,
  type LearningPath,
  type SearchConnection,
  type PodcastState,
  type TtsProvider,
  type LocalSpeechStatus
} from './discover'
import type { CaptureState, PhoneStatus } from './capture'
import type { InboxItem } from './inbox'
import {
  LensRun,
  LensSave,
  LensLand,
  SeriesInput,
  RecordingFiltersSchema,
  type LensInfo,
  type Derivation,
  type Landing,
  type SceneGuess,
  type Series,
  type SeriesDetail,
  type PersonPageData
} from './lens'
import {
  RecordingBegin,
  RecordingChunk,
  RecordingId,
  RecordingMarker,
  PersonInput,
  SpeakerChoice,
  TranscriptFormat,
  type Recording,
  type Person,
  type RecordingSpeaker,
  type VoiceStatus
} from './recording'
import { z } from 'zod'
import { ImportOptionsSchema } from './importer'
import type { Insights } from './insights'
import { WorkCreateSchema, WorkUpdateSchema, type VideoRender, type Work } from './works'
import { AdvisorAskSchema, AdvisorWeightsSchema, DecideSchema, ReviewDecisionSchema, type Decision } from './advisor'
import {
  EventRange,
  EventSave,
  PhaseSave,
  MilestoneSave,
  IcsSave,
  ScheduleOptions,
  type SchedulePreview,
  type GoalPhase,
  type GoalMilestone,
  type IcsFeed,
  type PlanEvent,
  type ReviewForecast
} from './plan'
import { ActivityBatchSchema, type TodayBriefing, type TodaySummary } from './activity'
import {
  ApprovalDecisionSchema,
  AuditQuerySchema,
  McpClientCreateSchema,
  McpClientPatchSchema,
  McpServerInputSchema,
  McpToolPolicyInputSchema,
  type ApprovalRequest,
  type AuditEntry,
  type McpClientInfo,
  type McpClientSecret,
  type McpServeStatus,
  type McpServerInfo,
  type UsageSummary,
  type UsageDashboard,
  type UsageCall,
  type ProviderBalance,
  UsageRangeSchema,
  UsageFilterSchema
} from './agent'
import type { MoneySettings } from './money'
import { RestoreSchema, type BackupPreview, type BackupStatus, type RecordingCryptoStatus } from './backup'
import { NetworkRuleSchema, DomainSchema, type NetworkRule } from './browserSafety'
import * as M from './mistakes'
import * as R from './reading'
import * as S from './schemas'
import type {
  AppInfo,
  AssetRef,
  AsrStatus,
  MossStatus,
  BackupInfo,
  BlockInfo,
  Category,
  ChatMessage,
  Conversation,
  EmbeddingStatus,
  RecognizerStatus,
  Annotation,
  AnnotationWithTarget,
  BrowserState,
  CourseQuiz,
  SourceRecognition,
  RegionRecognition,
  ScanPageText,
  HeatmapDay,
  ImportResult,
  Job,
  Memory,
  Concept,
  FeynmanReport,
  Reflection,
  ReflectionOverview,
  ReflectionMaterial,
  ReflectionHarvest,
  Insight,
  InsightVersion,
  ActionItem,
  Goal,
  GoalProgress,
  MasteryMap,
  NoteConnections,
  KnowledgeGraph,
  ReviewCard,
  CardListItem,
  FeynmanHome,
  ReviewStats,
  AnswerCheck,
  MemorySettings,
  Note,
  NoteSummary,
  Profile,
  Proposal,
  ProviderInfo,
  ProviderTestResult,
  Revision,
  RevisionInfo,
  SearchHit,
  Segment,
  Settings,
  SkillInfo,
  Source,
  Attachment,
  Tag,
  TrashItem,
  UserProfile,
  Vault
} from './types'

// 能力注册表：每个能力声明一次（名称、有序参数、说明、AI 可见性），由此自动生成：
//   1. 渲染进程 window.jiwei 接口（类型 + preload 桥接）
//   2. 主进程 IPC 处理与参数校验
//   3. AI 工具列表（v0.2）与 MCP 接口（v1.0）
//
// 新增能力：在此声明 → 在 main/ipc.ts 中实现（类型系统会强制要求）。

type Param = readonly [name: string, schema: z.ZodType]
type ParamList = readonly Param[]

export interface AiExposure {
  /** read：只读查询；write：会产生修改（AI 只能通过“提案”等可审核的方式写入） */
  effect: 'read' | 'write'
}

export interface Capability<P extends ParamList = ParamList, R = unknown> {
  description: string
  params: P
  /** 不填表示 AI 不可调用（如删除、迁移数据目录等） */
  ai?: AiExposure
  /** 仅用于类型推导 */
  readonly __result?: R
}

function cap<R>() {
  return <const P extends ParamList>(def: { description: string; params: P; ai?: AiExposure }): Capability<P, R> => def
}

/* ——— 类型推导 ——— */

type ArgsOf<P extends ParamList> = {
  -readonly [K in keyof P]: P[K] extends readonly [string, infer Sc extends z.ZodType] ? z.input<Sc> : never
}
/** 末尾可为 undefined 的参数变为可选参数 */
type OptionalTail<T extends unknown[]> = T extends [...infer H, infer L] ? (undefined extends L ? [...OptionalTail<H>, L?] : T) : T
export type CapFn<C> = C extends Capability<infer P, infer R> ? (...args: OptionalTail<ArgsOf<P>>) => Promise<R> : never
export type ParsedArgs<C> =
  C extends Capability<infer P, unknown>
    ? { -readonly [K in keyof P]: P[K] extends readonly [string, infer Sc extends z.ZodType] ? z.output<Sc> : never }
    : never
export type ResultOf<C> = C extends Capability<ParamList, infer R> ? R : never

const none = [] as const
const id = (name = 'id') => [name, S.Id] as const

export const capabilities = {
  mistakes: {
    create: cap<M.MistakeIngestion>()({ description: '录入手动错题', params: [['input', M.MistakeCreateSchema]] }),
    fromInbox: cap<M.MistakeIngestion>()({ description: '从收件箱原件加入错题本', params: [id()] }),
    fromBrowserCapture: cap<M.MistakeIngestion>()({ description: '从已验证的浏览器框选加入错题本', params: [id()] }),
    get: cap<M.Mistake | null>()({ description: '错题详情', params: [id()] }),
    list: cap<M.Mistake[]>()({ description: '筛选错题本', params: [['filters', M.MistakeFiltersSchema]] }),
    update: cap<M.Mistake>()({ description: '编辑或核对错题', params: [id(), ['patch', M.MistakePatchSchema]] }),
    retry: cap<M.MistakeIngestion>()({ description: '重试错题拆分', params: [id()] }),
    prepare: cap<M.MistakeLanding>()({ description: '准备错题康奈尔行提案', params: [id()] }),
    complete: cap<M.Mistake>()({ description: '确认错题提案已在renderer应用', params: [id(), id('proposalId'), ['update', S.Bytes]] }),
    remove: cap<M.MistakeLanding | null>()({ description: '准备移除错题及对应行', params: [id()] }),
    removeComplete: cap<void>()({ description: '确认错题删除提案', params: [id(), id('proposalId'), ['update', S.Bytes]] }),
    practice: cap<M.MistakePractice>()({ description: '选择已预生成的变式或原题', params: [id()] }),
    replenish: cap<string | null>()({ description: '后台补足变式池', params: [id(), ['immediate', z.boolean().optional()]] }),
    flag: cap<M.MistakePractice>()({ description: '标记变式题有误并换题', params: [id('variantId')] }),
    check: cap<AnswerCheck>()({
      description: '对照变式或原题检查作答',
      params: [id(), ['variantId', M.MistakeId.nullable()], ['answer', M.MistakePracticeAnswerSchema]]
    }),
    useVariant: cap<void>()({ description: '记录本次已用变式并补池', params: [id('variantId')] }),
    variants: cap<M.MistakeVariant[]>()({ description: '变式题记录', params: [id()] }),
    variantStats: cap<M.MistakeVariantStats>()({ description: '独立校验丢弃统计', params: none }),
    statistics: cap<import('./learningStats').MistakeStatistics>()({ description: '学习者错因分布', params: none })
  },
  reading: {
    state: cap<R.ReadingState>()({ description: '资料或网页的阅读模式', params: [['target', R.ReadingTargetSchema]] }),
    configure: cap<R.ReadingState>()({ description: '设置对照阅读与按水平注释', params: [['input', R.ReadingConfigureSchema]] }),
    estimate: cap<R.ReadingEstimate>()({ description: '首次阅读费用估计', params: [['target', R.ReadingTargetSchema]] }),
    translate: cap<R.ReadingBatchResult>()({ description: '翻译视口附近的段落并注释', params: [['input', R.ReadingBatchSchema]] }),
    profile: cap<R.VocabularyProfile>()({ description: '个人词汇水平和已知词', params: none }),
    setThreshold: cap<R.VocabularyProfile>()({ description: '调整个人词频阈值', params: [['threshold', R.ThresholdSchema]] }),
    recognize: cap<R.VocabularyProfile>()({ description: '记录认识超纲词', params: [['word', R.WordSchema]] }),
    query: cap<R.VocabularyProfile>()({ description: '记录主动查词', params: [['word', R.WordSchema]] }),
    prepare: cap<R.VocabularyLanding>()({ description: '准备生词本康奈尔行提案', params: [['input', R.VocabularyInputSchema]] }),
    complete: cap<R.VocabularyLanding>()({ description: '确认生词本renderer落地', params: [id('proposalId'), ['update', S.Bytes]] }),
    clearCache: cap<{ removed: number }>()({ description: '清空本机翻译缓存', params: none }),
    cacheStats: cap<{ bytes: number; entries: number }>()({ description: '本机翻译缓存占用', params: none }),
    usage: cap<{ calls: number; inputTokens: number; outputTokens: number; cost: number | null }>()({
      description: '本次阅读实际模型费用',
      params: [['target', R.ReadingTargetSchema]]
    })
  },
  lenses: {
    list: cap<LensInfo[]>()({ description: '整理视角', params: none }),
    save: cap<LensInfo>()({
      description: '保存自定义视角',
      params: [
        ['input', LensSave],
        ['id', S.Id.optional()]
      ]
    }),
    remove: cap<void>()({ description: '删除自定义视角', params: [id()] }),
    guess: cap<SceneGuess | null>()({ description: '判断未指定录音场景', params: [id('sourceId')] }),
    chooseScene: cap<void>()({
      description: '用户选择录音场景',
      params: [id('sourceId'), ['scene', z.enum(['meeting', 'lecture', 'thought'])]]
    }),
    run: cap<Derivation>()({ description: '后台整理转写稿', params: [['input', LensRun]] }),
    history: cap<Derivation[]>()({ description: '整理历史', params: [id('sourceId')] }),
    estimate: cap<{ cost: number | null; runAfter: number; offPeak: boolean }>()({
      description: '整理费用与夜间开始时间',
      params: [id('sourceId')]
    }),
    duplicates: cap<string[]>()({ description: '疑似重复条目', params: [id('derivationId')] }),
    landings: cap<Landing[]>()({ description: '落地记录', params: [id('derivationId')] }),
    prepare: cap<Landing>()({ description: '创建用户已审阅的提案', params: [['input', LensLand]] }),
    complete: cap<Landing>()({ description: '确认renderer已应用提案', params: [id(), ['update', S.Bytes]] }),
    undo: cap<Landing>()({ description: '准备撤销未修改的落地', params: [id()] }),
    undoComplete: cap<Landing>()({ description: '确认renderer已撤销提案', params: [id(), ['update', S.Bytes]] })
  },
  series: {
    list: cap<Series[]>()({ description: '录音系列', params: none }),
    save: cap<Series>()({
      description: '新建或修改系列',
      params: [
        ['input', SeriesInput],
        ['id', S.Id.optional()]
      ]
    }),
    set: cap<void>()({ description: '修改资料所属系列', params: [id('sourceId'), ['seriesId', S.Id.nullable()]] }),
    detail: cap<SeriesDetail>()({ description: '系列录音与行动项', params: [id()] }),
    openActions: cap<ActionItem[]>()({ description: '系列未完成待办', params: [id()] })
  },
  recording: {
    cryptoStatus: cap<RecordingCryptoStatus>()({ description: '录音加密与迁移状态', params: none }),
    prepareRecovery: cap<string>()({ description: '生成待确认的恢复码', params: none }),
    saveRecovery: cap<void>()({ description: '保存当前待确认的恢复码', params: none }),
    confirmRecovery: cap<void>()({ description: '确认恢复码最后一组并启用加密', params: [['group', z.string().max(20)]] }),
    cancelRecovery: cap<void>()({ description: '放弃未确认的恢复码', params: none }),
    unlock: cap<void>()({ description: '输入恢复码解锁', params: [['code', z.string().max(100)]] }),
    encryption: cap<void>()({
      description: '启用或二次确认关闭加密',
      params: [
        ['enabled', z.boolean()],
        ['confirmed', z.boolean()]
      ]
    }),
    deferEncryption: cap<void>()({ description: '暂不加密', params: none }),
    pauseMigration: cap<void>()({ description: '暂停录音文件迁移', params: none }),
    resumeMigration: cap<void>()({ description: '继续录音文件迁移', params: none }),
    list: cap<Recording[]>()({ description: '本机录音', params: none }),
    get: cap<Recording>()({ description: '录音状态', params: [['id', RecordingId]] }),
    begin: cap<Recording>()({ description: '开始录音', params: [['input', RecordingBegin]] }),
    chunk: cap<void>()({ description: '持久化音轨分块', params: [['input', RecordingChunk]] }),
    pause: cap<void>()({
      description: '暂停或继续录音',
      params: [
        ['id', RecordingId],
        ['paused', z.boolean()]
      ]
    }),
    finish: cap<Recording>()({ description: '结束或恢复录音', params: [['id', RecordingId]] }),
    discard: cap<void>()({ description: '丢弃录音（可撤销）', params: [['id', RecordingId]] }),
    restore: cap<void>()({ description: '撤销丢弃', params: [['id', RecordingId]] }),
    mark: cap<void>()({
      description: '录音打点',
      params: [
        ['id', RecordingId],
        ['marker', RecordingMarker]
      ]
    }),
    summarize: cap<string>()({ description: '最近一分钟摘要', params: [['id', RecordingId]] }),
    permissions: cap<{ mic: string; system: boolean }>()({ description: '音频权限状态', params: none }),
    requestMic: cap<boolean>()({ description: '首次请求麦克风权限', params: none }),
    openMicSettings: cap<void>()({ description: '打开系统麦克风权限', params: none }),
    storage: cap<{ bytes: number; recordings: { id: string; sourceId: string | null; bytes: number }[] }>()({
      description: '本机音频占用',
      params: none
    }),
    deleteAudio: cap<void>()({ description: '删除音频保留转写稿', params: [['id', RecordingId]] }),
    speakers: cap<RecordingSpeaker[]>()({ description: '说话人确认状态', params: [id('sourceId')] }),
    confirm: cap<void>()({ description: '确认说话人或只改一句', params: [['input', SpeakerChoice]] }),
    export: cap<string | null>()({ description: '导出转写稿', params: [id('sourceId'), ['format', TranscriptFormat]] })
  },
  people: {
    page: cap<PersonPageData>()({ description: '人物录音、行动项与观点', params: [id()] }),
    list: cap<Person[]>()({ description: '登记的人', params: none }),
    save: cap<Person>()({
      description: '新建或改名',
      params: [
        ['input', PersonInput],
        ['id', S.Id.optional()]
      ]
    }),
    remove: cap<void>()({ description: '删除人员与声纹', params: [id()] }),
    merge: cap<void>()({ description: '合并人员与关联', params: [id('from'), id('to')] }),
    clear: cap<void>()({
      description: '清除声纹向量',
      params: [
        ['removeNames', z.boolean()],
        ['personId', S.Id.optional()]
      ]
    }),
    corrections: cap<{ id: string; from: string; to: string; count: number; lastUsedAt: number }[]>()({
      description: '热词纠错',
      params: none
    }),
    removeCorrection: cap<void>()({ description: '删除热词纠错', params: [id()] })
  },
  voiceprint: {
    status: cap<VoiceStatus>()({ description: '说话人识别组件', params: none }),
    install: cap<void>()({ description: '下载 CAM++', params: none }),
    remove: cap<void>()({ description: '删除 CAM++', params: none }),
    enroll: cap<void>()({
      description: '登记我的声音',
      params: [['bytes', z.instanceof(Uint8Array).refine((b) => b.length > 0 && b.length <= 8 * 1024 * 1024)]]
    })
  },
  capture: {
    open: cap<void>()({ description: '打开捕捉小窗', params: [['mode', z.enum(['text', 'screenshot'])]] }),
    state: cap<CaptureState | null>()({ description: '捕捉状态', params: none }),
    close: cap<void>()({ description: '关闭捕捉', params: none }),
    context: cap<void>()({ description: '保留主窗口光标', params: [id(), ['noteId', S.Id.nullable()]] }),
    delivered: cap<void>()({ description: '主窗口确认处理', params: [id(), ['error', z.string().max(500).nullable()]] }),
    shortcuts: cap<string[]>()({ description: '快捷键注册冲突', params: none }),
    paste: cap<string>()({ description: '显式粘贴新剪贴板内容', params: [id()] }),
    attach: cap<void>()({
      description: '附加捕捉文件',
      params: [
        id(),
        ['bytes', z.instanceof(Uint8Array).refine((v) => v.byteLength <= 25 * 1024 * 1024)],
        ['name', z.string().max(260)],
        ['mime', z.string().max(120)]
      ]
    }),
    crop: cap<void>()({
      description: '整屏框选',
      params: [
        id(),
        [
          'rect',
          z.object({
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().positive(),
            height: z.number().int().positive()
          })
        ]
      ]
    }),
    action: cap<void>()({ description: '保存或发送捕捉', params: [['input', CaptureActionSchema]] })
  },
  phone: {
    start: cap<PhoneStatus>()({ description: '开启局域网上传', params: none }),
    status: cap<PhoneStatus | null>()({ description: '上传进度', params: none }),
    stop: cap<void>()({ description: '停止指定上传会话', params: [id()] })
  },
  inbox: {
    list: cap<InboxItem[]>()({ description: '收件箱条目', params: [['includeDeleted', z.boolean().optional()]] }),
    get: cap<InboxItem | null>()({ description: '收件箱原件', params: [id()] }),
    create: cap<InboxItem>()({ description: '捕捉内容', params: [['input', S.InboxCreateSchema]] }),
    update: cap<InboxItem>()({ description: '修改或忽略条目', params: [id(), ['patch', S.InboxUpdateSchema]] }),
    remove: cap<void>()({ description: '删除捕捉', params: [id()] }),
    restore: cap<void>()({ description: '恢复捕捉', params: [id()] }),
    retryRecognition: cap<string>()({ description: '重新识别原图片', params: [id()] }),
    accept: cap<InboxItem>()({ description: '接受或手动归档', params: [id(), ['manual', S.InboxAcceptSchema.optional()]] }),
    complete: cap<InboxItem[]>()({
      description: '持久化已应用的收件箱提案',
      params: [id('proposalId'), ['update', z.instanceof(Uint8Array).refine((v) => v.byteLength <= 20_000_000)]]
    }),
    triage: cap<number>()({ description: '整理收件箱', params: [['ids', z.array(S.Id).max(1000).optional()]] }),
    estimate: cap<number | null>()({ description: '整理费用估算', params: none })
  },
  app: {
    showInFolder: cap<void>()({ description: '在文件管理器中显示文件', params: [['path', z.string().min(1).max(4096)]] }),
    info: cap<AppInfo>()({ description: '应用版本与数据目录信息', params: none }),
    openDataDir: cap<void>()({ description: '在系统文件管理器中打开数据目录', params: none }),
    changeDataDir: cap<boolean>()({ description: '把当前知识库迁移到新的空文件夹并重启', params: none }),
    flushDone: cap<void>()({ description: '渲染进程完成保存后回复主进程', params: none })
  },
  vaults: {
    list: cap<Vault[]>()({ description: '列出所有知识库', params: none }),
    create: cap<Vault | null>()({ description: '在新的空文件夹中创建知识库', params: [['name', z.string().min(1).max(100)]] }),
    open: cap<Vault | null>()({ description: '打开已有的知识库文件夹', params: none }),
    switch: cap<void>()({ description: '切换到指定知识库（重启应用）', params: [id()] }),
    rename: cap<void>()({ description: '重命名知识库', params: [id(), ['name', z.string().min(1).max(100)]] })
  },
  profile: {
    get: cap<Profile>()({ description: '当前用户与设备', params: none }),
    setName: cap<Profile>()({ description: '设置你的名字（协作时显示）', params: [['name', z.string().min(1).max(60)]] })
  },
  backups: {
    list: cap<BackupInfo[]>()({ description: '列出数据库备份', params: none }),
    create: cap<BackupInfo>()({ description: '立即完整备份', params: [['includeProfile', z.boolean().optional()]] }),
    status: cap<BackupStatus>()({ description: '备份进度和外部位置状态', params: none }),
    export: cap<string | null>()({ description: '导出完整备份', params: [['includeProfile', z.boolean().optional()]] }),
    preview: cap<BackupPreview | null>()({ description: '预览备份文件或本地快照', params: [['name', z.string().max(300).optional()]] }),
    restore: cap<{ id: string; name: string; path: string } | null>()({
      description: '校验并恢复知识库',
      params: [['input', RestoreSchema]]
    }),
    cancel: cap<void>()({ description: '取消备份或恢复', params: none }),
    pickExternal: cap<string | null>()({ description: '选择外部备份文件夹', params: none }),
    reveal: cap<void>()({ description: '打开备份目录', params: none })
  },
  settings: {
    get: cap<Settings>()({ description: '读取设置', params: none }),
    set: cap<Settings>()({ description: '修改设置', params: [['patch', S.SettingsPatchSchema]] })
  },
  categories: {
    list: cap<Category[]>()({ description: '列出分类（含层级关系）', params: [['kind', S.CategoryKindSchema]], ai: { effect: 'read' } }),
    create: cap<Category>()({
      description: '新建分类',
      params: [
        ['kind', S.CategoryKindSchema],
        ['name', z.string().min(1).max(200)],
        ['parentId', S.Id.nullable().optional()]
      ]
    }),
    update: cap<void>()({ description: '修改分类名称、父分类或颜色', params: [id(), ['patch', S.CategoryPatchSchema]] }),
    remove: cap<void>()({ description: '删除分类（进入最近删除）', params: [id()] })
  },
  tags: {
    list: cap<Tag[]>()({ description: '列出全部标签', params: none, ai: { effect: 'read' } }),
    ensure: cap<Tag>()({ description: '按名称获取或创建标签', params: [['name', z.string().min(1).max(100)]] }),
    rename: cap<void>()({ description: '重命名标签', params: [id(), ['name', z.string().min(1).max(100)]] }),
    remove: cap<void>()({ description: '删除标签', params: [id()] }),
    set: cap<void>()({
      description: '设置笔记或资料的标签',
      params: [
        ['entityType', S.EntityTypeSchema],
        ['entityId', S.Id],
        ['tagIds', z.array(S.Id).max(100)]
      ]
    })
  },
  notes: {
    list: cap<NoteSummary[]>()({ description: '按条件列出 / 检索笔记', params: [['query', S.NoteQuerySchema]], ai: { effect: 'read' } }),
    get: cap<Note | null>()({ description: '读取笔记元信息', params: [id()], ai: { effect: 'read' } }),
    create: cap<Note>()({ description: '新建笔记', params: [['init', S.NoteInitSchema]] }),
    export: cap<string | null>()({
      description: '导出笔记（Markdown / HTML / PDF / Word）',
      params: [
        id(),
        ['format', z.enum(['md', 'html', 'pdf', 'docx'])],
        [
          'images',
          z.record(
            z.string().max(64),
            z.object({
              svg: z.string().max(4_000_000).optional(),
              png: z.string().max(12_000_000).optional(),
              width: z.number().optional(),
              height: z.number().optional()
            })
          )
        ]
      ]
    }),
    createSample: cap<Note>()({ description: '创建示例笔记《如何使用康奈尔笔记法》', params: [['lang', z.enum(['zh-CN', 'en'])]] }),
    update: cap<NoteSummary>()({ description: '修改笔记元信息', params: [id(), ['patch', S.NoteMetaUpdateSchema]] }),
    trash: cap<void>()({ description: '删除笔记（进入最近删除）', params: [id()] }),
    loadDoc: cap<Uint8Array>()({ description: '读取 Yjs 文档状态', params: [id()] }),
    pushUpdate: cap<void>()({ description: '追加 Yjs 增量', params: [id(), ['update', S.Bytes]] }),
    blocks: cap<BlockInfo[]>()({ description: '读取笔记的段落块（含时间戳与来源）', params: [id()], ai: { effect: 'read' } })
  },
  revisions: {
    list: cap<RevisionInfo[]>()({ description: '列出笔记的历史版本', params: [id('noteId')] }),
    get: cap<Revision | null>()({ description: '读取一个历史版本', params: [id()] }),
    create: cap<RevisionInfo>()({
      description: '保存一个版本',
      params: [id('noteId'), ['reason', z.enum(['manual', 'restore']).optional()]]
    })
  },
  proposals: {
    create: cap<Proposal>()({
      description: '向笔记提交修改提案（由用户逐条确认后才生效）。AI 修改笔记的唯一方式。',
      params: [['input', S.ProposalInputSchema]],
      ai: { effect: 'write' }
    }),
    list: cap<Proposal[]>()({ description: '列出笔记中待处理的提案', params: [id('noteId')] }),
    resolve: cap<Proposal>()({
      description: '接受或拒绝提案中的一条操作',
      params: [
        id(),
        ['opIndex', z.number().int().min(0)],
        ['decision', z.enum(['accepted', 'rejected'])],
        /** 接受时编辑器写入的块 ID（用于学习技能偏好） */
        ['blockIds', z.array(S.Id).max(500).optional()]
      ]
    })
  },
  sandbox: {
    register: cap<string>()({ description: '登记交互演示页面，返回沙箱地址', params: [['html', z.string().min(1).max(400_000)]] })
  },
  assets: {
    importBytes: cap<AssetRef>()({
      description: '把字节存入素材库',
      params: [
        ['name', z.string().max(260)],
        ['mime', z.string().max(120)],
        ['bytes', S.Bytes]
      ]
    })
  },
  attachments: {
    add: cap<Attachment[]>()({ description: '把文件添加到对话附件空间', params: [['input', S.AttachmentAddSchema]] }),
    pick: cap<string[]>()({ description: '选择附件文件', params: none }),
    status: cap<Attachment[]>()({ description: '读取附件处理状态', params: [['sourceIds', z.array(S.Id).max(500)]] }),
    ofConversation: cap<Attachment[]>()({ description: '本对话的附件', params: [id('conversationId')] }),
    removeFromConversation: cap<void>()({ description: '从本对话移出附件', params: [id('conversationId'), id('sourceId')] }),
    list: cap<Attachment[]>()({ description: '附件空间', params: [['filter', S.AttachmentListSchema]] }),
    archive: cap<void>()({
      description: '将附件归档到资料库',
      params: [
        ['sourceIds', z.array(S.Id).max(500)],
        ['categoryId', S.Id.nullable()]
      ]
    }),
    delete: cap<void>()({ description: '删除附件，移入最近删除', params: [['sourceIds', z.array(S.Id).max(500)]] }),
    count: cap<number>()({ description: '未归档附件数量', params: none })
  },
  sources: {
    readiness: cap<Record<string, Readiness>>()({
      description: '批量读取允许AI访问的资料处理状态；附件仅所属对话有效',
      params: [
        ['ids', z.array(z.string().min(1).max(64)).max(500)],
        ['conversationId', z.string().max(64).nullable().optional()]
      ]
    }),
    retry: cap<void>()({
      description: '重新读取允许访问的资料，复用现有解析作业',
      params: [id(), ['conversationId', z.string().max(64).nullable().optional()]]
    }),
    list: cap<Source[]>()({ description: '按条件列出 / 检索资料', params: [['query', S.SourceQuerySchema]], ai: { effect: 'read' } }),
    get: cap<Source | null>()({ description: '读取资料信息', params: [id()], ai: { effect: 'read' } }),
    notes: cap<{ id: string; title: string; updatedAt: number }[]>()({ description: '与这份资料关联的笔记', params: [id()] }),
    outline: cap<{ title: string; page: number | null; ordinal: number }[]>()({
      description: '资料的章节目录（识别出的标题）',
      params: [id()]
    }),
    indexStatus: cap<{ segments: number; indexable: number; embedded: number; semantic: boolean }>()({
      description: '资料的检索准备情况：正文数、可索引数和当前模型完成数；附件限所属对话',
      params: [id(), ['conversationId', S.Id.nullable().optional()]]
    }),
    importDialog: cap<ImportResult>()({ description: '通过对话框导入文件', params: [['categoryId', S.Id.nullable().optional()]] }),
    importPaths: cap<ImportResult>()({
      description: '按路径导入文件（拖拽）',
      params: [
        ['paths', z.array(z.string().min(1).max(4096)).max(500)],
        ['categoryId', S.Id.nullable().optional()]
      ]
    }),
    addUrl: cap<Source>()({
      description: '添加网址资料',
      params: [
        ['url', z.url({ protocol: /^https?$/ })],
        ['title', z.string().max(500).optional()],
        ['categoryId', S.Id.nullable().optional()]
      ]
    }),
    update: cap<void>()({ description: '修改资料信息', params: [id(), ['patch', S.SourceUpdateSchema]] }),
    open: cap<void>()({ description: '用系统应用打开资料', params: [id()] }),
    reveal: cap<void>()({ description: '在文件夹中显示资料', params: [id()] }),
    trash: cap<void>()({ description: '删除资料（进入最近删除）', params: [id()] })
  },
  segments: {
    resolve: cap<string | null>()({
      description: '解析仍可读取的资料片段永久身份，附件仅所属对话有效',
      params: [id(), ['conversationId', z.string().max(64).nullable().optional()]]
    }),
    get: cap<Segment | null>()({
      description: '按片段身份读取允许用于智能界面的资料原文',
      params: [id(), ['conversationId', z.string().max(64).nullable().optional()]]
    }),
    update: cap<Segment | null>()({
      description: '修改片段文字（如纠正转写错误）',
      params: [id(), ['text', z.string().min(1).max(20000)]]
    }),
    list: cap<Segment[]>()({ description: '读取资料的分段内容', params: [id('sourceId')], ai: { effect: 'read' } }),
    search: cap<Segment[]>()({
      description: '在资料正文中全文检索',
      params: [
        ['query', z.string().min(1).max(500)],
        ['sourceId', S.Id.optional()]
      ],
      ai: { effect: 'read' }
    })
  },
  jobs: {
    list: cap<Job[]>()({ description: '列出后台任务', params: none }),
    cancel: cap<void>()({ description: '取消后台任务', params: [id()] }),
    retry: cap<void>()({ description: '重试失败的后台任务', params: [id()] }),
    runNow: cap<void>()({ description: '排到低谷时段的任务现在就开始', params: [id()] }),
    digestNow: cap<void>()({ description: '不再等待识别，使用已有内容现在就整理', params: [id()] })
  },
  trash: {
    list: cap<TrashItem[]>()({ description: '列出最近删除', params: none }),
    restore: cap<void>()({ description: '还原', params: [['type', S.TrashTypeSchema], id()] }),
    purge: cap<void>()({ description: '永久删除', params: [['type', S.TrashTypeSchema], id()] }),
    empty: cap<void>()({ description: '清空最近删除', params: none })
  },
  providers: {
    list: cap<ProviderInfo[]>()({ description: '列出模型服务商（不含 API Key 明文）', params: none }),
    save: cap<ProviderInfo>()({ description: '新增或修改模型服务商', params: [['input', S.ProviderInputSchema]] }),
    remove: cap<void>()({ description: '删除模型服务商', params: [id()] }),
    fetchModels: cap<string[]>()({ description: '从服务商拉取可用模型列表', params: [id()] }),
    test: cap<ProviderTestResult>()({ description: '测试服务商连接', params: [id()] })
  },
  chatProjects: {
    list: cap<ChatProject[]>()({ description: '列出对话项目', params: none }),
    get: cap<ChatProject | null>()({ description: '读取对话项目', params: [id()] }),
    create: cap<ChatProject>()({ description: '创建对话项目', params: [['input', ProjectCreateSchema]] }),
    update: cap<ChatProject>()({ description: '修改对话项目', params: [id(), ['patch', ProjectUpdateSchema]] }),
    remove: cap<void>()({ description: '删除项目，保留或同时删除对话', params: [id(), ['mode', z.enum(['recent', 'delete'])]] }),
    conversations: cap<ChatProjectConversation[]>()({ description: '列出项目对话', params: [id()] }),
    exportMarkdown: cap<string | null>()({ description: '导出项目对话为 Markdown 文件夹', params: [id()] })
  },
  chat: {
    search: cap<ChatSearchHit[]>()({ description: '搜索对话标题与消息', params: [['query', z.string().max(200)]] }),
    get: cap<Conversation | null>()({ description: '读取指定对话，包括就地提问，用于重发原问题', params: [id('conversationId')] }),
    conversations: cap<Conversation[]>()({ description: '列出 AI 对话', params: none }),
    messages: cap<ChatMessage[]>()({ description: '读取对话消息', params: [id('conversationId')] }),
    send: cap<{ conversation: Conversation; userMessage: ChatMessage; assistantMessageId: string }>()({
      description: '发送消息并开始生成回答（流式结果通过事件推送）',
      params: [['input', S.ChatSendSchema]]
    }),
    stop: cap<void>()({ description: '停止生成', params: [id('messageId')] }),
    threads: cap<Conversation[]>()({ description: '某份资料 / 笔记上的就地提问', params: [id('parentId')] }),
    saveAnswer: cap<{ noteId: string; created: boolean }>()({
      description: '把回答存入笔记（新增一行：线索为问题，笔记为答案与出处）',
      params: [['input', S.SaveAnswerSchema]]
    }),
    update: cap<void>()({
      description: '修改对话标题、检索范围或置顶',
      params: [
        id(),
        [
          'patch',
          z.object({
            title: z.string().max(200).optional(),
            projectId: z.string().min(1).max(64).nullable().optional(),
            scope: S.ChatScopeSchema.optional(),
            pinned: z.boolean().optional(),
            web: WebModeSchema.nullable().optional()
          })
        ]
      ]
    }),
    remove: cap<void>()({ description: '删除对话', params: [id()] })
  },
  memory: {
    list: cap<Memory[]>()({ description: '列出记忆', params: [['query', S.MemoryQuerySchema]] }),
    save: cap<Memory>()({ description: '新增或修改记忆（用户操作）', params: [['input', S.MemoryInputSchema]] }),
    remove: cap<void>()({ description: '删除记忆', params: [id()] }),
    confirm: cap<Memory | null>()({ description: '确认待确认的记忆', params: [id()] }),
    profile: cap<UserProfile>()({ description: '读取个人档案', params: none }),
    setProfile: cap<UserProfile>()({ description: '修改个人档案', params: [['patch', S.UserProfileSchema]] }),
    settings: cap<MemorySettings>()({ description: '读取记忆设置', params: none }),
    setSettings: cap<MemorySettings>()({ description: '修改记忆设置', params: [['patch', S.MemorySettingsSchema]] }),
    concepts: cap<Concept[]>()({ description: '学习者模型：各概念的掌握情况', params: none }),
    removeConcept: cap<void>()({ description: '删除一个概念的学习记录', params: [id()] }),
    setConceptLevel: cap<void>()({
      description: '校正某个概念的掌握程度',
      params: [id(), ['level', z.enum(['weak', 'learning', 'solid'])]]
    }),
    learnNow: cap<{ added: number; concepts: number; episode: boolean }>()({
      description: '立即整理某个对话中的记忆、学习情况与学习经历',
      params: [id()]
    }),
    maintain: cap<{ reviewed: number; skills: number; faded: number }>()({
      description: '立即执行记忆维护：检查 AI 内容是否被修改、归纳技能偏好、淡出久未使用的记忆',
      params: [['opts', z.object({ force: z.boolean().optional() })]]
    })
  },
  reflection: {
    overview: cap<ReflectionOverview>()({ description: '复盘概览：今天 / 本周的复盘、最近的复盘、未完成的行动项', params: none }),
    start: cap<Reflection>()({ description: '开始一次复盘（每日 / 每周按时间段只有一份）', params: [['input', S.ReflectionStartSchema]] }),
    get: cap<Reflection | null>()({ description: '读取一次复盘', params: [id()] }),
    remove: cap<void>()({ description: '删除一次复盘（复盘笔记进入最近删除）', params: [id()] }),
    answers: cap<string[]>()({ description: '各引导问题下的回答', params: [id()] }),
    material: cap<ReflectionMaterial>()({ description: '复盘素材包（由数据统计生成）', params: [id()] }),
    saveDaily: cap<Reflection>()({
      description: '保存每日微复盘的三个回答',
      params: [['answers', z.array(z.string().max(2000)).length(3)]]
    }),
    harvest: cap<ReflectionHarvest>()({ description: 'AI 从复盘中提炼洞见、修正与行动项（供确认）', params: [id()] }),
    commit: cap<Reflection>()({ description: '保存确认的洞见、修正与行动项，复盘完成', params: [id(), ['input', S.HarvestCommitSchema]] })
  },
  learningInsights: {
    get: cap<Insights>()({
      description: '洞察看板：一段时间的投入、内化、产出、成本与知识漏斗（只读统计）',
      params: [['range', z.union([z.literal(7), z.literal(30), z.literal(90)])]]
    })
  },
  works: {
    list: cap<Work[]>()({ description: '创作工坊：全部作品', params: none }),
    get: cap<Work>()({ description: '读取一个作品（含素材与正文）', params: [id('id')] }),
    create: cap<Work>()({ description: '新建作品（图文长文、课件 PPT、讲解视频）', params: [['input', WorkCreateSchema]] }),
    update: cap<Work>()({
      description: '修改作品：标题、选题、受众、模式、阶段、正文、发布记录、复盘',
      params: [['input', WorkUpdateSchema]]
    }),
    remove: cap<void>()({ description: '删除作品', params: [id('id')] }),
    topics: cap<{ title: string; angle: string; audience: string; why: string }[]>()({
      description: '根据掌握得好的知识与方向推荐选题（花费 AI 费用）',
      params: [id('id')]
    }),
    gather: cap<Work>()({
      description: '按选题从知识库收集素材（只含允许给 AI 的内容）',
      params: [id('id'), ['query', z.string().max(500).optional()]]
    }),
    dropMaterial: cap<Work>()({ description: '移除一条素材', params: [id('id'), id('materialId')] }),
    outline: cap<Work>()({ description: '生成结构：长文为章节、课件为逐页（花费 AI 费用）', params: [id('id')] }),
    draft: cap<Work>()({
      description: '起草：长文逐节（教练模式只给提示问题）、课件补全所有页（花费 AI 费用）',
      params: [id('id'), ['partId', z.string().max(40).optional()]]
    }),
    polish: cap<Work>()({ description: '打磨：受众视角挑刺、核对事实依据、标出讲不清的地方（花费 AI 费用）', params: [id('id')] }),
    unclearToCards: cap<{ noteId: string; count: number }>()({
      description: '把讲不清的地方写成复习卡片',
      params: [id('id'), ['indexes', z.array(z.number().int().min(0)).min(1).max(20)]]
    }),
    export: cap<string | null>()({
      description: '导出作品：长文 md / docx / pdf，课件 pptx / md',
      params: [id('id'), ['format', z.enum(['md', 'docx', 'pdf', 'pptx'])]]
    }),
    render: cap<string>()({ description: '渲染讲解视频（配音、逐帧录制、编码；云端配音按字数计费）', params: [id('id')] }),
    renderStatus: cap<VideoRender>()({ description: '讲解视频的渲染进度', params: [id('id')] }),
    cancelRender: cap<void>()({ description: '取消正在渲染的视频', params: [id('id')] }),
    exportVideo: cap<string | null>()({
      description: '另存渲染好的视频、字幕或分镜表',
      params: [id('id'), ['format', z.enum(['mp4', 'srt', 'json'])]]
    })
  },
  advisor: {
    list: cap<Decision[]>()({ description: '决策日志：全部决策（未删除）', params: none }),
    get: cap<Decision>()({ description: '读取一条决策及其备忘录（依据会复核是否仍可用）', params: [id('id')] }),
    due: cap<Decision[]>()({ description: '已到回看日期、尚未回看的决策', params: none }),
    ask: cap<Decision>()({
      description: '提出一个问题：检索知识库依据并生成决策备忘录（花费 AI 费用）',
      params: [['input', AdvisorAskSchema]]
    }),
    regenerate: cap<Decision>()({ description: '重新生成决策备忘录（花费 AI 费用）', params: [id('id')] }),
    cancel: cap<void>()({ description: '停止参谋生成，保留输入和已有备忘录', params: [id('target')] }),
    running: cap<string[]>()({ description: '正在生成的参谋任务：ask 或决策 ID', params: none }),
    weights: cap<Decision>()({
      description: '调整决策矩阵的准则权重（null 恢复建议权重）',
      params: [id('id'), ['weights', AdvisorWeightsSchema]]
    }),
    decide: cap<Decision>()({ description: '记录选定的选项、当时的预期与回看日期', params: [['input', DecideSchema]] }),
    review: cap<Decision>()({
      description: '回看：记录实际结果、预期准确度与教训，可生成复习卡片',
      params: [['input', ReviewDecisionSchema]]
    }),
    status: cap<Decision>()({ description: '把决策设为草稿或放弃', params: [id('id'), ['status', z.enum(['draft', 'dropped'])]] }),
    remove: cap<void>()({ description: '删除一条决策', params: [id('id')] })
  },
  discover: {
    feeds: cap<Feed[]>()({ description: '订阅源及最近抓取状态', params: none }),
    feedSave: cap<Feed>()({ description: '保存订阅源，启用后立即抓取', params: [['input', FeedSave]] }),
    feedRemove: cap<void>()({ description: '移除订阅源，保留已保存内容', params: [id()] }),
    feedRefresh: cap<void>()({ description: '刷新一个启用的订阅源', params: [id()] }),
    items: cap<FeedItem[]>()({ description: '精选条目；可选读取全部状态用于管理', params: [['all', z.boolean().optional()]] }),
    act: cap<{ url: string; sourceId?: string; target?: { type: 'note' | 'source'; id: string } }>()({
      description: '记录读、存、稍后或不感兴趣；存为资料走真实抓取与分段',
      params: [['input', DiscoverAct]]
    }),
    runNow: cap<string>()({ description: '排队运行每日精选，遵守每日名额和费用上限', params: none }),
    status: cap<DiscoveryStatus>()({ description: '当日精选运行状态、费用与去重可用性', params: none }),
    searchProviders: cap<SearchConnection[]>()({ description: '搜索连接状态，只返回凭证是否设置', params: none }),
    searchSave: cap<void>()({ description: '用系统加密保存搜索 Key，启用一个服务', params: [['input', SearchSave]] }),
    searchTest: cap<{ ok: boolean; message: string }>()({
      description: '测试所选搜索服务，错误不包含凭证',
      params: [['service', SearchProvider]]
    }),
    path: cap<LearningPath>()({ description: '结合知识库与搜索生成学习路径提案，正文待用户接受', params: [['goalId', z.string().min(1)]] }),
    pathPhases: cap<SchedulePreview>()({ description: '把主进程持有的学习路径转为仅追加阶段的排期预览', params: [id()] }),
    remedy: cap<string[]>()({
      description: '为允许 AI 的错题找讲解与练习，写入不占每日名额的精选',
      params: [['mistakeId', z.string().min(1)]]
    }),
    podcast: cap<PodcastState>()({ description: '读取当日学习播客讲稿与状态，素材隐私变化时旧稿失效', params: none }),
    podcastGenerate: cap<string>()({ description: '排队生成或覆盖当日播客讲稿，遵守发现预算与隐私，仅朗读问题不含答案', params: none }),
    ttsProviders: cap<TtsProvider[]>()({ description: '可用于播客 AI 语音合成的服务商（已配置 Key 的通义、OpenAI）', params: none }),
    speechStatus: cap<LocalSpeechStatus>()({ description: '本机语音模型（ZipVoice）的下载状态与占用空间', params: none }),
    speechInstall: cap<void>()({ description: '下载本机语音模型（约 190 MB）', params: none }),
    speechCancel: cap<void>()({ description: '取消下载本机语音模型', params: none }),
    speechRemove: cap<void>()({ description: '删除本机语音模型，释放磁盘', params: none }),
    voicePreview: cap<string>()({
      description: '试听播客声音：合成一句示例并返回音频地址（云端按字数计费）',
      params: [
        ['engine', z.enum(['local', 'ai'])],
        ['voice', z.string().max(40)],
        ['providerId', z.string().max(64).nullable()]
      ]
    })
  },
  mail: {
    accounts: cap<MailAccount[]>()({ description: '列出邮箱账号与凭证已设置状态，不返回凭证明文', params: none }),
    save: cap<MailAccount>()({ description: '加密保存只读邮箱连接', params: [['input', MailSave]] }),
    test: cap<{ ok: boolean; message: string }>()({ description: '测试只读邮箱连接，错误不包含凭证', params: [id()] }),
    help: cap<void>()({
      description: '在系统浏览器打开所选邮箱官方授权码帮助',
      params: [['preset', z.enum(['qq', '163', '126', 'gmail', 'icloud'])]]
    }),
    remove: cap<void>()({ description: '移除邮箱并清除本地加密凭证与增量游标', params: [id()] })
  },
  tasks: {
    list: cap<AiTask[]>()({ description: '列出 AI 任务与最近结果和本月费用', params: none }),
    save: cap<AiTask>()({ description: '保存触发、工具、输出许可和预算', params: [['input', TaskSave]] }),
    remove: cap<void>()({ description: '删除任务并取消待运行任务', params: [id()] }),
    run: cap<string>()({ description: '运行一次已启用的任务；全局暂停时不执行', params: [id()] }),
    runs: cap<TaskRun[]>()({ description: '任务最近一百条运行记录', params: [id('taskId')] }),
    parse: cap<TaskInput>()({
      description: '一句话解析为可编辑任务预览，不保存',
      params: [['description', z.string().trim().min(1).max(4000)]]
    }),
    recipes: cap<PluginRegistryItem<TaskRecipe>[]>()({ description: '当前可用的任务配方', params: none }),
    tools: cap<TaskToolInfo[]>()({ description: '可勾选的只读工具，外部写入不可选', params: none }),
    pauseAll: cap<void>()({ description: '暂停或恢复所有 AI 任务', params: [['paused', z.boolean()]] }),
    chooseFolder: cap<string | null>()({ description: '选择非递归监听的任务文件夹', params: none })
  },
  plan: {
    schedulePreview: cap<SchedulePreview>()({
      description: '生成经时间与投入校验的排期预览；不写入',
      params: [['input', ScheduleOptions]]
    }),
    scheduleApply: cap<void>()({ description: '确认主进程持有的预览并事务写入；变化后须重新生成', params: [id('previewId')] }),
    phases: cap<GoalPhase[]>()({ description: '方向的阶段与完成进度', params: [id('goalId')] }),
    phaseSave: cap<GoalPhase>()({ description: '创建或修改阶段及挂接的笔记与资料', params: [['input', PhaseSave]] }),
    phaseRemove: cap<void>()({ description: '移除阶段；保留并解除挂接的任务、里程碑、日程', params: [id()] }),
    milestones: cap<GoalMilestone[]>()({ description: '方向的里程碑', params: [id('goalId')] }),
    milestoneSave: cap<GoalMilestone>()({ description: '创建或修改里程碑与完成日期', params: [['input', MilestoneSave]] }),
    milestoneRemove: cap<void>()({ description: '移除里程碑', params: [id()] }),
    icsFeeds: cap<IcsFeed[]>()({ description: '列出只读日历订阅', params: none }),
    icsSave: cap<IcsFeed>()({ description: '添加、编辑或隐藏日历订阅', params: [['input', IcsSave]] }),
    icsRefresh: cap<void>()({ description: '立即刷新日历订阅，失败保留上次成功快照', params: [id()] }),
    icsRemove: cap<void>()({ description: '移除日历订阅与来源日程', params: [id()] }),
    icsImport: cap<IcsFeed | null>()({ description: '选择并一次性导入本地 .ics 文件', params: none }),
    events: cap<PlanEvent[]>()({ description: '查询日历日程（含行动项与方向截止标记）', params: [['range', EventRange]] }),
    eventSave: cap<PlanEvent>()({ description: '新建或修改日程；订阅事件只读', params: [['input', EventSave]] }),
    eventRemove: cap<void>()({ description: '删除自己创建的日程', params: [id()] }),
    forecast: cap<ReviewForecast[]>()({
      description: '未来复习负荷的已排期下限',
      params: [['days', z.number().int().min(1).max(366).default(42)]]
    })
  },
  goals: {
    list: cap<Goal[]>()({ description: '列出方向', params: none }),
    save: cap<Goal>()({ description: '新建或修改方向', params: [['input', S.GoalInputSchema]] }),
    remove: cap<void>()({ description: '删除方向', params: [id()] }),
    progress: cap<GoalProgress>()({ description: '方向的进度（笔记、卡片、掌握比例、近 7 天复习）', params: [id()] }),
    linkNote: cap<Goal>()({ description: '把笔记关联到目标或取消关联', params: [id(), id('noteId'), ['linked', z.boolean()]] })
  },
  connections: {
    get: cap<NoteConnections>()({
      description: '笔记的关联：反向链接、手动关联、相关推荐、未链接的提及',
      params: [id('noteId')],
      ai: { effect: 'read' }
    }),
    relate: cap<void>()({
      description: '把笔记与另一篇笔记或资料关联（双向）；可指定关系类型（前置、推出、对比……），reverse 表示“对方 <关系> 本篇”',
      params: [
        id('noteId'),
        ['toType', z.enum(['note', 'source'])],
        id('toId'),
        ['relation', z.enum(RELATIONS).optional()],
        ['reverse', z.boolean().optional()]
      ]
    }),
    unrelate: cap<void>()({
      description: '取消关联，或把推荐标为不相关（以后不再推荐）',
      params: [id('noteId'), ['toType', z.enum(['note', 'source'])], id('toId')]
    }),
    linkMention: cap<boolean>()({
      description: '把另一篇笔记中提到本篇标题的文字变成链接（undo 为撤销）',
      params: [id('noteId'), id('mentionNoteId'), ['blockId', z.string().max(64)], ['undo', z.boolean().optional()]]
    })
  },
  graph: {
    data: cap<KnowledgeGraph>()({
      description: '知识结构图：笔记、资料与它们之间的链接、关联、出处',
      params: none,
      ai: { effect: 'read' }
    }),
    suggest: cap<{ judged: number; suggested: number }>()({
      description: '让 AI 判断连线的关系类型并发现缺失的关系；结果只是建议，需用户确认',
      params: none
    }),
    accept: cap<void>()({ description: '确认一条 AI 建议的关系', params: [id('linkId')] }),
    reject: cap<void>()({ description: '否决一条 AI 建议的关系（以后不再建议）', params: [id('linkId')] }),
    acceptAll: cap<number>()({ description: '确认全部 AI 建议的关系', params: none })
  },
  mastery: {
    map: cap<MasteryMap>()({ description: '掌握度地图：各笔记的掌握情况（可按目标筛选）', params: [['goalId', S.Id.nullable()]] })
  },
  insights: {
    list: cap<Insight[]>()({ description: '列出洞见', params: none }),
    history: cap<InsightVersion[]>()({ description: '洞见的版本历史（认知成长轨迹）', params: [id()] }),
    update: cap<Insight>()({ description: '修改洞见（新版本，记录原因）', params: [id(), ['patch', S.InsightUpdateSchema]] }),
    remove: cap<void>()({ description: '删除洞见', params: [id()] })
  },
  actions: {
    list: cap<ActionItem[]>()({ description: '列出行动项', params: [['status', z.enum(['open', 'done', 'dropped']).optional()]] }),
    create: cap<ActionItem>()({
      description: '新建行动项',
      params: [
        ['title', z.string().min(1).max(300)],
        ['dueAt', z.number().int().nullable()],
        ['goalId', S.Id.nullable().optional()]
      ]
    }),
    update: cap<ActionItem>()({ description: '修改行动项（完成 / 放弃 / 改期）', params: [id(), ['patch', S.ActionUpdateSchema]] }),
    remove: cap<void>()({ description: '删除行动项', params: [id()] })
  },
  feynman: {
    get: cap<Conversation | null>()({ description: '读取一次费曼练习（含诊断报告）', params: [id()] }),
    home: cap<FeynmanHome>()({ description: '费曼练习首页：历史练习与推荐的概念', params: none }),
    finish: cap<FeynmanReport>()({ description: '结束费曼练习并诊断：讲清楚了什么、漏洞、错误、建议的复习问题', params: [id()] }),
    addCues: cap<{ noteId: string; created: boolean }>()({
      description: '把选中的复习问题补进笔记（成为复习卡片）',
      params: [id(), ['indices', z.array(z.number().int().min(0)).min(1).max(10)]]
    })
  },
  review: {
    forecast: cap<ReviewForecast[]>()({
      description: '未来每天的到期与新卡负荷（不模拟 FSRS）',
      params: [['days', z.number().int().min(1).max(366).default(42)]]
    }),
    next: cap<ReviewCard | null>()({
      description: '下一张要复习的卡片（exclude：本轮刚复习过的）',
      params: [['exclude', z.array(S.Id).max(500)]]
    }),
    get: cap<ReviewCard | null>()({ description: '读取一张卡片', params: [id()] }),
    list: cap<CardListItem[]>()({
      description: '卡片库：按状态筛选、搜索问题或笔记标题',
      params: [
        ['filter', z.enum(['all', 'due', 'new', 'learning', 'review', 'suspended', 'weak'])],
        ['search', z.string().max(200).optional()]
      ]
    }),
    today: cap<(CardListItem & { bucket: 'learning' | 'due' | 'new' })[]>()({
      description: '今天的复习清单：学习中、今天到期、今天可学的新卡（按复习顺序）',
      params: none
    }),
    scheduledNow: cap<boolean>()({ description: '这张卡片现在是否该复习（自选复习时只有它计入排期）', params: [id()] }),
    practice: cap<void>()({
      description: '练习一张没到期的卡片：只记活动，不改变复习排期',
      params: [id(), ['durationMs', z.number().int().min(0).optional()]]
    }),
    stats: cap<ReviewStats>()({ description: '复习统计：到期数量、今日已复习、连续天数、记住比例', params: none }),
    rate: cap<ReviewCard | null>()({
      description: '为卡片评分（1 忘了 2 困难 3 记得 4 轻松）',
      params: [
        id(),
        ['rating', z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])],
        ['durationMs', z.number().int().min(0).optional()],
        ['variantId', M.MistakeId.nullable().optional()]
      ]
    }),
    undo: cap<ReviewCard | null>()({ description: '撤销这张卡片最近一次评分', params: [id()] }),
    suspend: cap<void>()({ description: '暂停或恢复一张卡片', params: [id(), ['suspended', z.boolean()]] }),
    forNote: cap<{ id: string; rowId: string; state: ReviewCard['state']; due: number; suspended: boolean }[]>()({
      description: '某篇笔记的复习卡片',
      params: [id('noteId')]
    }),
    check: cap<AnswerCheck>()({
      description: 'AI 对照当前练习检查用户的回答',
      params: [id(), ['answer', z.string().min(1).max(5000)], ['variantId', M.MistakeId.nullable().optional()]]
    })
  },
  skills: {
    list: cap<SkillInfo[]>()({ description: '列出技能', params: none }),
    read: cap<string>()({ description: '读取技能正文（SKILL.md）', params: [['name', z.string().max(257)]] }),
    setEnabled: cap<SkillInfo[]>()({
      description: '启用或停用技能',
      params: [
        ['name', z.string().max(257)],
        ['enabled', z.boolean()]
      ]
    }),
    import: cap<SkillInfo | null>()({ description: '导入技能（选择包含 SKILL.md 的文件夹）', params: none }),
    importPath: cap<SkillInfo>()({ description: '从路径导入技能', params: [['path', z.string().min(1).max(4096)]] }),
    openDir: cap<void>()({ description: '打开用户技能文件夹', params: none }),
    reload: cap<SkillInfo[]>()({ description: '重新扫描技能', params: none })
  },
  asr: {
    status: cap<AsrStatus>()({ description: '语音转写引擎状态', params: none }),
    install: cap<void>()({ description: '下载并安装语音转写引擎（sherpa-onnx + SenseVoice）', params: none }),
    transcribe: cap<void>()({
      description: '为视频 / 音频生成转写稿（后台任务）',
      params: [id('sourceId'), ['overwrite', z.boolean().optional()]]
    }),
    importSubtitles: cap<number | null>()({ description: '为视频 / 音频导入字幕文件', params: [id('sourceId')] })
  },
  browser: {
    networkStatus: cap<{ proxyAvailable: boolean; rules: NetworkRule[] }>()({ description: '网站网络规则', params: none }),
    networkRules: cap<void>()({ description: '修改内置浏览器网络', params: [['rules', z.array(NetworkRuleSchema).max(500)]] }),
    openExternal: cap<void>()({ description: '在系统浏览器继续', params: [id('tabId')] }),
    externalSite: cap<void>()({
      description: '以后用系统浏览器打开或撤销',
      params: [
        ['site', DomainSchema],
        ['enabled', z.boolean()]
      ]
    }),
    dismissLogin: cap<void>()({ description: '关闭登录受阻提示', params: [id('tabId')] }),
    state: cap<BrowserState>()({ description: '内置浏览器的标签页状态', params: none }),
    seek: cap<void>()({
      description: '网页视频跳到时间点，视频就绪后执行',
      params: [id('tabId'), ['t', z.number().finite().min(0).max(604800)], ['play', z.boolean().optional()]]
    }),
    playback: cap<void>()({ description: '播放或暂停网页视频', params: [id('tabId'), ['play', z.boolean()]] }),
    open: cap<string>()({
      description: '在内置浏览器中打开网址或搜索（新标签页或当前标签页），返回标签页 ID',
      params: [
        ['input', z.string().max(4000)],
        ['opts', z.object({ incognito: z.boolean().optional(), newTab: z.boolean().optional() }).optional()]
      ]
    }),
    navigate: cap<void>()({ description: '在标签页中打开网址或搜索', params: [id('tabId'), ['input', z.string().min(1).max(4000)]] }),
    command: cap<void>()({
      description: '后退、前进、刷新、停止',
      params: [id('tabId'), ['cmd', z.enum(['back', 'forward', 'reload', 'stop'])]]
    }),
    activate: cap<void>()({ description: '切换标签页', params: [id('tabId')] }),
    close: cap<void>()({ description: '关闭标签页', params: [id('tabId')] }),
    setBounds: cap<void>()({
      description: '网页显示区域（窗口坐标）；null 表示不显示',
      params: [['rect', S.BrowserRectSchema.nullable()]]
    }),
    captureBegin: cap<BrowserCaptureFrame>()({ description: '冻结当前网页供框选识别', params: none }),
    captureRecognize: cap<BrowserCaptureResult>()({ description: '识别冻结帧中的区域', params: [id('id'), ['rect', CaptureRectSchema]] }),
    captureRelease: cap<void>()({ description: '释放框选及摘抄缓存', params: [id('id')] }),
    capturePrepare: cap<BrowserCaptureResult>()({
      description: '复核框选身份并可加入连续摘抄',
      params: [id('id'), ['commit', z.boolean().optional()], ['requireCurrent', z.boolean().optional()]]
    }),
    captureSaved: cap<boolean>()({ description: '确认浏览器摘抄已写入持久化笔记', params: [id('proposalId')] }),
    captureSave: cap<{ noteId: string; created: boolean; proposalId: string }>()({
      description: '合并框选摘抄并存入笔记',
      params: [
        ['entries', BrowserCaptureEntriesSchema],
        ['noteId', S.Id.nullable()]
      ]
    }),
    freeze: cap<string | null>()({ description: '弹出层盖住网页时暂停显示，返回截图', params: [['on', z.boolean()]] }),
    saveSource: cap<string>()({
      description: '把网页存为资料（同一网址复用），返回资料 ID',
      params: [['tabId', S.Id.nullable().optional()]]
    }),
    recapCheck: cap<{ sourceId: string; title: string; highlights: number; questions: number } | null>()({
      description: '关闭标签页前：是否提示把这篇的高亮与问答整理成笔记',
      params: [id('tabId')]
    }),
    recap: cap<{ noteId: string; proposalId: string }>()({
      description: '把网页资料上的高亮、批注与问答整理成康奈尔笔记（提案）',
      params: [id('sourceId'), ['noteId', S.Id.nullable()]]
    }),
    readPage: cap<{ url: string; title: string; text: string; selection: string }>()({
      description: '读取内置浏览器当前网页的正文',
      params: [['tabId', S.Id.nullable().optional()]]
    })
  },
  moss: {
    status: cap<MossStatus>()({ description: '精修转写引擎的安装与运行状态', params: none }),
    install: cap<void>()({ description: '下载并校验可选 MOSS 精修引擎', params: none }),
    remove: cap<void>()({ description: '删除 MOSS 精修引擎与模型', params: none }),
    refine: cap<void>()({ description: '精修音视频并区分说话人', params: [id('sourceId'), ['overwrite', z.boolean().optional()]] })
  },
  course: {
    configure: cap<void>()({ description: '设置当前网课的转写、幻灯片和练习', params: [id('tabId'), ['patch', S.CourseOptionsSchema]] }),
    snapshot: cap<string | null>()({ description: '截取当前视频画面供就地提问', params: [id('tabId')] }),
    organize: cap<{ noteId: string; proposalId: string }>()({
      description: '根据课程证据整理康奈尔笔记提案',
      params: [id('sourceId'), ['noteId', S.Id.nullable()]]
    }),
    estimate: cap<number | null>()({ description: '预估课后整理费用（美元）', params: [id('sourceId')] }),
    quiz: cap<CourseQuiz>()({ description: '根据刚播放的文字稿生成提取练习题', params: [id('tabId')] }),
    check: cap<string>()({ description: '评价本次课程练习答案', params: [id('quizId'), ['answer', z.string().max(4000)]] }),
    review: cap<{ noteId: string; proposalId: string }>()({
      description: '把课程练习加入当前笔记的复习提案',
      params: [id('quizId'), ['noteId', S.Id.nullable()]]
    })
  },
  annotations: {
    list: cap<Annotation[]>()({
      description: '列出笔记或资料上的批注（高亮、评论、存疑）',
      params: [
        ['targetType', z.enum(['note', 'source'])],
        ['targetId', S.Id]
      ],
      ai: { effect: 'read' }
    }),
    recent: cap<AnnotationWithTarget[]>()({
      description: '最近的批注（含所在笔记 / 资料标题）',
      params: [['since', z.number().int().min(0)]],
      ai: { effect: 'read' }
    }),
    create: cap<Annotation>()({ description: '添加批注', params: [['input', S.AnnotationInputSchema]] }),
    update: cap<Annotation>()({ description: '修改批注', params: [id(), ['patch', S.AnnotationPatchSchema]] }),
    remove: cap<void>()({ description: '删除批注', params: [id()] }),
    restore: cap<void>()({ description: '撤销删除批注', params: [id()] }),
    exportPdf: cap<string | null>()({ description: '导出带批注的 PDF（标准 PDF 批注），返回保存路径', params: [id('sourceId')] })
  },
  recognition: {
    scanPages: cap<ScanPageText[]>()({ description: '扫描页的可选中文字层', params: [id('sourceId')] }),
    formula: cap<RegionRecognition | null>()({ description: '本地识别当前笔记图片中的公式', params: [id('noteId'), id('imageId')] }),
    status: cap<RecognizerStatus>()({ description: '文档识别引擎（本地模型）状态', params: none }),
    install: cap<void>()({ description: '下载本地文档识别模型（LightOnOCR-2-1B）', params: none }),
    remove: cap<void>()({ description: '删除本地文档识别模型', params: none }),
    source: cap<SourceRecognition>()({
      description: '资料的识别情况（扫描页、表格页、图页）',
      params: [id('sourceId')],
      ai: { effect: 'read' }
    }),
    start: cap<void>()({ description: '识别资料中的扫描页、表格（后台任务）', params: [id('sourceId')] })
  },
  embedding: {
    status: cap<EmbeddingStatus>()({ description: '向量模型与索引状态', params: none }),
    installLocal: cap<void>()({ description: '下载并启动内置向量模型（EmbeddingGemma 2）', params: none }),
    reindex: cap<void>()({ description: '重建知识库索引', params: none })
  },
  knowledge: {
    queryFor: cap<string>()({
      description: '仅供评测：构造与线上相同的追问检索文字',
      params: [
        ['text', z.string().max(2000)],
        ['prev', z.string().max(20000).nullable()]
      ]
    }),
    search: cap<SearchHit[]>()({
      description: '在知识库（笔记与资料）中检索与问题相关的片段，结果带时间与状态',
      params: [
        ['query', z.string().min(1).max(2000)],
        ['scope', S.ChatScopeSchema],
        ['limit', z.number().int().min(1).max(30).optional()],
        ['filters', RecordingFiltersSchema.optional()]
      ],
      ai: { effect: 'read' }
    })
  },
  stats: {
    heatmap: cap<HeatmapDay[]>()({ description: '学习热力图数据', params: [['days', z.number().int().min(1).max(3660)]] })
  },
  activity: {
    track: cap<void>()({ description: '上报一批有效学习时长', params: [['spans', ActivityBatchSchema]] }),
    clear: cap<void>()({ description: '清除全部学习活动记录', params: none })
  },
  today: {
    summary: cap<TodaySummary>()({
      description: '今日首页：到期复习、错题、收件箱、提案、行动项、目标与投入时长',
      params: none,
      ai: { effect: 'read' }
    }),
    briefing: cap<TodayBriefing>()({ description: '今天的 AI 晨报（一天生成一次）', params: [['refresh', z.boolean().optional()]] })
  },
  /* ——— v0.7 智能体底座 ——— */
  usage: {
    summary: cap<UsageSummary>()({ description: '本月 AI 花费、每日柱状、按用途与模型分项、上限状态', params: none }),
    allowToday: cap<void>()({ description: '达到上限后今天继续使用', params: none }),
    clear: cap<void>()({ description: '清除 AI 记账', params: none }),
    dashboard: cap<UsageDashboard>()({
      description: '用量看板：时段内的总量、对比、趋势、服务商、用途、最贵的几次',
      params: [['range', UsageRangeSchema]]
    }),
    calls: cap<{ rows: UsageCall[]; total: number }>()({ description: '用量明细（分页、筛选）', params: [['filter', UsageFilterSchema]] }),
    exportCsv: cap<string | null>()({ description: '把用量明细导出为 CSV，返回文件路径', params: [['filter', UsageFilterSchema]] }),
    balances: cap<ProviderBalance[]>()({ description: '查询服务商余额（DeepSeek、Kimi）', params: none }),
    updateRates: cap<MoneySettings>()({ description: '联网更新汇率', params: none })
  },
  agent: {
    decide: cap<boolean>()({ description: '确认卡片：允许或拒绝', params: [['decision', ApprovalDecisionSchema]] }),
    pending: cap<ApprovalRequest[]>()({ description: '等待确认的步骤', params: none }),
    audit: cap<AuditEntry[]>()({ description: '审计日志', params: [['query', AuditQuerySchema]] }),
    auditCallers: cap<string[]>()({ description: '审计日志中出现过的调用方', params: none }),
    exportAudit: cap<string | null>()({ description: '导出审计日志（JSON）', params: none }),
    clearAudit: cap<void>()({ description: '清除审计日志', params: none })
  },
  manim: {
    status: cap<import('./manim').ManimStatus>()({ description: '数学动画运行环境的状态', params: none }),
    install: cap<void>()({
      description: '下载并安装数学动画运行环境（可复用本机 LaTeX）',
      params: [['options', z.object({ useSystemTex: z.boolean().optional() })]]
    }),
    cancel: cap<void>()({ description: '取消安装', params: none }),
    remove: cap<number>()({ description: '删除运行环境，返回释放的字节数', params: none }),
    clip: cap<string>()({ description: '生成（或取缓存的）笔记数学动画，返回 jiwei:// 地址', params: [['animation', AnimationSchema]] })
  },
  plugins: {
    roleCatalog: cap<RoleCatalogCard[]>()({ description: '实际角色目录、内容数量与安装启用状态', params: none }),
    beginRoleSelection: cap<string>()({ description: '创建窗口拥有的可取消角色选择', params: none }),
    previewRoles: cap<RoleBatchPreview>()({
      description: '合并预览所选角色，不安装',
      params: [
        ['token', z.string().length(64)],
        ['ids', z.array(z.string().min(1).max(257)).min(1).max(8)]
      ]
    }),
    confirmRoles: cap<RoleBatchRecovery>()({
      description: '一次确认角色批次，返回已安装和待重试状态',
      params: [
        ['token', z.string().length(64)],
        ['selections', RoleBatchSelections]
      ]
    }),
    cancelRoleSelection: cap<void>()({ description: '取消本窗口角色批次，保留已经提交的包', params: [['token', z.string().length(64)]] }),
    roleRecovery: cap<RoleBatchRecovery | null>()({ description: '上次角色确认的真实持久化恢复状态', params: none }),
    roleStarters: cap<RoleStarters[]>()({ description: '启用角色的未关闭起步卡与逐项完成状态', params: none }),
    activateStarter: cap<PluginStarter['action']>()({
      description: '记录点击完成并返回经过身份验证的纯导航动作，不运行模型或任务',
      params: [
        ['pluginId', z.string().min(1).max(257)],
        ['starterId', z.string().min(1).max(257)]
      ]
    }),
    dismissStarters: cap<void>()({ description: '关闭角色起步卡并持久化', params: [['pluginId', z.string().min(1).max(257)]] }),
    markets: cap<PluginMarketInfo[]>()({ description: '市场清单与每个市场的缓存状态', params: none }),
    catalog: cap<PluginCatalogCard[]>()({ description: '缓存中的合并插件目录', params: none }),
    addMarket: cap<PluginMarketInfo>()({ description: '添加已确认信任的第三方市场', params: [['input', MarketInputSchema]] }),
    removeMarket: cap<void>()({
      description: '删除市场，默认同时卸载插件',
      params: [
        ['name', MarketNameSchema],
        ['options', z.object({ uninstall: z.boolean().default(true) })]
      ]
    }),
    refreshMarket: cap<PluginMarketInfo[]>()({
      description: '刷新市场；staleOnly 用于打开市场页',
      params: [
        ['name', MarketNameSchema.optional()],
        ['staleOnly', z.boolean().default(false)]
      ]
    }),
    beginAcquisition: cap<string>()({ description: '创建本窗口拥有的可取消获取操作', params: none }),
    acquire: cap<PluginDetection>()({
      description: '识别来源，返回市场、技能选择或确认预览',
      params: [
        ['operation', z.string().length(64)],
        ['source', PluginInspectSource]
      ]
    }),
    acquireUpdate: cap<PluginPreview>()({
      description: '可取消的更新获取与预览',
      params: [
        ['operation', z.string().length(64)],
        ['id', z.string().max(257)]
      ]
    }),
    acquireFile: cap<PluginDetection | null>()({
      description: '通过原生选择器识别插件来源',
      params: [['operation', z.string().length(64)]]
    }),
    acquirePath: cap<PluginDetection>()({
      description: '开发测试：识别指定路径',
      params: [
        ['operation', z.string().length(64)],
        ['path', z.string().max(4096)]
      ]
    }),
    cancelAcquisition: cap<void>()({ description: '取消下载和尚未完成的预览', params: [['operation', z.string().length(64)]] }),
    selectSkills: cap<PluginDetection>()({
      description: '确认技能集合选择并生成安装预览',
      params: [
        ['operation', z.string().length(64)],
        ['token', z.string().length(64)],
        ['paths', z.array(z.string().max(4000)).min(1).max(2000)]
      ]
    }),
    addDetectedMarket: cap<PluginMarketInfo>()({
      description: '确认添加已识别的市场',
      params: [
        ['operation', z.string().length(64)],
        ['token', z.string().length(64)]
      ]
    }),
    details: cap<PluginDetails>()({
      description: '已安装或已预览插件的内容与安全 README',
      params: [['input', z.union([z.object({ id: z.string().max(257) }).strict(), z.object({ token: z.string().length(64) }).strict()])]]
    }),
    list: cap<PluginInfo[]>()({ description: '已安装插件', params: none }),
    get: cap<PluginInfo>()({ description: '插件详情（无明文敏感值）', params: [['id', z.string().max(257)]] }),
    inspect: cap<PluginPreview>()({ description: '获取来源并预览插件', params: [['source', PluginInspectSource]] }),
    installFromFile: cap<PluginPreview | null>()({ description: '选择本地插件并预览', params: none }),
    inspectPath: cap<PluginPreview>()({ description: '开发测试：从路径预览', params: [['path', z.string().max(4096)]] }),
    confirmInstall: cap<PluginInfo>()({
      description: '确认安装已预览的插件',
      params: [
        ['token', z.string().length(64)],
        ['options', PluginConfirmOptions]
      ]
    }),
    cancel: cap<void>()({ description: '取消安装预览', params: [['token', z.string().length(64)]] }),
    update: cap<PluginPreview>()({ description: '预览来源更新及新增能力', params: [['id', z.string().max(257)]] }),
    rollback: cap<PluginInfo>()({ description: '回滚已确认的上个版本', params: [['id', z.string().max(257)]] }),
    setEnabled: cap<PluginInfo>()({
      description: '启停插件文字内容；启用不会开启 MCP',
      params: [
        ['id', z.string().max(257)],
        ['enabled', z.boolean()]
      ]
    }),
    setConfig: cap<PluginInfo>()({
      description: '保存插件配置并停用需重新启用的 MCP',
      params: [
        ['id', z.string().max(257)],
        ['values', PluginConfigValues]
      ]
    }),
    uninstall: cap<void>()({
      description: '卸载插件，默认保留订阅源与任务',
      params: [
        ['id', z.string().max(257)],
        ['options', PluginUninstallOptions]
      ]
    }),
    openFolder: cap<void>()({ description: '打开已安装插件文件夹', params: [['id', z.string().max(257)]] }),
    customize: cap<string>()({ description: '把已装插件复制成可编辑的本地副本，返回副本名', params: [['id', z.string().max(257)]] }),
    createRolePack: cap<{ name: string; skipped: string[] }>()({
      description: '从现有技能、视角、任务和订阅源组装角色包（只生成文件，安装另需预览确认）',
      params: [
        [
          'input',
          z.object({
            name: z.string().trim().min(1).max(40),
            description: z.string().trim().max(200).optional(),
            skills: z.array(z.string().min(1).max(257)).max(30).optional(),
            tasks: z.array(z.string().min(1).max(64)).max(10).optional(),
            feeds: z.array(z.string().min(1).max(64)).max(30).optional()
          })
        ]
      ]
    }),
    acquireAuthored: cap<PluginDetection>()({
      description: '识别积微自制目录里的插件（路径由主进程决定）',
      params: [
        ['operation', z.string().length(64)],
        [
          'name',
          z
            .string()
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
            .max(64)
        ]
      ]
    }),
    openAuthored: cap<void>()({
      description: '打开自制插件的可编辑文件夹',
      params: [
        [
          'name',
          z
            .string()
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
            .max(64)
        ]
      ]
    }),
    exportPlugin: cap<string | null>()({
      description: '导出为 Claude Code 格式的插件文件夹和 zip，可选附带市场文件',
      params: [
        ['id', z.string().max(257)],
        ['withMarketplace', z.boolean()]
      ]
    }),
    templates: cap<PluginRegistryItem<PluginTemplate>[]>()({ description: '启用的作品模板', params: none }),
    frameworks: cap<PluginRegistryItem<PluginFramework>[]>()({ description: '启用的参谋框架', params: none }),
    recipes: cap<PluginRegistryItem<TaskRecipe | PluginRecipe>[]>()({ description: '启用的任务配方', params: none })
  },
  mcp: {
    servers: cap<McpServerInfo[]>()({ description: '接入的外部 MCP 服务器', params: none }),
    saveServer: cap<McpServerInfo>()({ description: '添加或修改外部 MCP 服务器', params: [['input', McpServerInputSchema]] }),
    removeServer: cap<void>()({ description: '删除外部 MCP 服务器', params: [['id', z.string().max(64)]] }),
    testServer: cap<McpServerInfo>()({ description: '连接（必要时在浏览器中登录）并列出工具', params: [['id', z.string().max(64)]] }),
    logoutServer: cap<McpServerInfo>()({ description: '退出外部服务器的登录', params: [['id', z.string().max(64)]] }),
    setToolPolicy: cap<McpServerInfo>()({ description: '设置外部工具的策略', params: [['input', McpToolPolicyInputSchema]] }),
    serveStatus: cap<McpServeStatus>()({ description: '积微 MCP 服务状态', params: none }),
    clients: cap<McpClientInfo[]>()({ description: '使用积微的客户端', params: none }),
    createClient: cap<McpClientSecret>()({ description: '添加客户端（返回一次令牌与配置）', params: [['input', McpClientCreateSchema]] }),
    updateClient: cap<McpClientInfo>()({
      description: '修改客户端',
      params: [
        ['id', z.string().max(64)],
        ['patch', McpClientPatchSchema]
      ]
    }),
    rotateToken: cap<McpClientSecret>()({ description: '重新生成客户端令牌', params: [['id', z.string().max(64)]] }),
    removeClient: cap<void>()({ description: '删除客户端', params: [['id', z.string().max(64)]] })
  },
  updates: {
    status: cap<import('./updates').UpdateState>()({ description: '应用更新状态', params: none }),
    check: cap<import('./updates').UpdateState>()({ description: '检查应用更新', params: none }),
    download: cap<import('./updates').UpdateState>()({ description: '下载并校验应用更新', params: none }),
    install: cap<void>()({ description: '安装已校验的应用更新', params: none }),
    acknowledge: cap<void>()({ description: '关闭已升级提示', params: none }),
    openLink: cap<void>()({ description: '在系统浏览器打开更新说明', params: [['url', z.string().max(2000).optional()]] })
  },
  importer: {
    choose: cap<import('./importer').ImportScan | null>()({
      description: '选择并扫描笔记库',
      params: [['mode', z.enum(['folder', 'files', 'notion', 'notion-folder'])]]
    }),
    inspect: cap<import('./importer').ImportScan>()({
      description: '开发测试：扫描本地笔记库',
      params: [['paths', z.array(z.string().max(4096)).min(1).max(5000)]]
    }),
    scan: cap<import('./importer').ImportScan>()({ description: '扫描进度与预览清单', params: [['id', z.string().max(64)]] }),
    cancelScan: cap<void>()({ description: '取消扫描', params: [['id', z.string().max(64)]] }),
    preview: cap<import('./importer').ImportPreview>()({
      description: '转换后的只读康奈尔预览',
      params: [
        ['id', z.string().max(64)],
        ['path', z.string().max(4096)]
      ]
    }),
    estimate: cap<import('./importer').ImportEstimate>()({
      description: '估算补线索调用与费用',
      params: [
        ['id', z.string().max(64)],
        ['paths', z.array(z.string().max(4096)).max(5000)]
      ]
    }),
    start: cap<import('./importer').ImportRun>()({
      description: '导入所选笔记',
      params: [
        ['id', z.string().max(64)],
        ['options', ImportOptionsSchema]
      ]
    }),
    run: cap<import('./importer').ImportRun>()({ description: '导入进度与结果', params: [['id', z.string().max(64)]] }),
    history: cap<import('./importer').ImportRun[]>()({ description: '导入历史', params: none }),
    cancel: cap<void>()({ description: '取消导入', params: [['id', z.string().max(64)]] }),
    cancelCues: cap<void>()({ description: '取消本次导入的补线索任务', params: [['id', z.string().max(64)]] }),
    undo: cap<import('./importer').ImportRun>()({ description: '把本次导入移入回收站', params: [['id', z.string().max(64)]] })
  },
  retrieval: {
    upgradeStatus: cap<{ total: number; done: number; running: boolean; paused: boolean }>()({
      description: '读取资料检索升级的进度',
      params: none
    }),
    status: cap<RetrievalStatus>()({ description: '联网服务状态与今日用量', params: none }),
    saveBackend: cap<void>()({ description: '保存联网搜索服务配置', params: [['input', BackendSaveSchema]] }),
    testBackend: cap<{ ok: boolean; message: string }>()({ description: '测试联网搜索服务', params: [['id', z.enum(BACKEND_IDS)]] }),
    page: cap<WebPageView | null>()({ description: '查看网页快照', params: [id()] }),
    savePage: cap<{ sourceId: string }>()({ description: '将网页快照存为资料', params: [id()] }),
    clearCache: cap<{ searches: number; pages: number }>()({ description: '清理搜索缓存与未被引用的网页快照', params: none }),
    usage: cap<RetrievalUsage>()({ description: '联网搜索与读取次数', params: [['range', z.enum(['today', 'month'])]] })
  },
  ui: {
    canShareDerived: cap<boolean>()({ description: '检查回答的派生内容是否可写入共享模块', params: [id('messageId')] }),
    states: cap<Record<string, unknown>>()({ description: '读取某条回答里组件的状态', params: [id('messageId')] }),
    saveState: cap<void>()({
      description: '保存组件状态（滑块、勾选、作答）',
      params: [id('messageId'), ['componentId', z.string().max(80)], ['state', z.unknown()]]
    }),
    saveToNote: cap<{ noteId: string; created: boolean; proposalId: string }>()({
      description: '把回答里的组件存进笔记',
      params: [['input', S.UiSaveToNoteSchema]]
    })
  }
} as const

export type Capabilities = typeof capabilities

/** 渲染进程可调用的完整 API（由注册表推导） */
export type JiweiAPI = { [NS in keyof Capabilities]: { [M in keyof Capabilities[NS]]: CapFn<Capabilities[NS][M]> } }

/** 所有能力的扁平列表：[命名空间, 方法名, 定义] */
export function eachCapability(): [string, string, Capability][] {
  return Object.entries(capabilities).flatMap(([ns, methods]) =>
    Object.entries(methods).map(([m, def]) => [ns, m, def as Capability] as [string, string, Capability])
  )
}

/** 按注册表校验 IPC 参数；缺省的尾部参数补 undefined */
export function parseArgs(def: Capability, args: unknown[]): unknown[] {
  return def.params.map(([name, schema], i) => {
    const r = schema.safeParse(args[i])
    if (!r.success)
      throw new Error(`Invalid argument "${name}": ${r.error.issues.map((x) => `${x.path.join('.') || name} ${x.message}`).join('; ')}`)
    return r.data
  })
}

/** 供 AI 使用的工具定义（JSON Schema） */
export function aiTools(): { name: string; description: string; effect: AiExposure['effect']; inputSchema: unknown }[] {
  return eachCapability()
    .filter(([, , d]) => d.ai)
    .map(([ns, m, d]) => ({
      name: `${ns}_${m}`,
      description: d.description,
      effect: d.ai!.effect,
      inputSchema: z.toJSONSchema(z.object(Object.fromEntries(d.params.map(([n, s]) => [n, s]))), { unrepresentable: 'any' })
    }))
}
