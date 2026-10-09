import { CaptureRectSchema, BrowserCaptureEntriesSchema, type BrowserCaptureFrame, type BrowserCaptureResult } from './browserCapture'
import { CaptureActionSchema } from './capture'
import type { CaptureState, PhoneStatus } from './capture'
import type { InboxItem } from './inbox'
import { z } from 'zod'
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
    create: cap<BackupInfo>()({ description: '立即备份数据库', params: none }),
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
  sources: {
    list: cap<Source[]>()({ description: '按条件列出 / 检索资料', params: [['query', S.SourceQuerySchema]], ai: { effect: 'read' } }),
    get: cap<Source | null>()({ description: '读取资料信息', params: [id()], ai: { effect: 'read' } }),
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
    retry: cap<void>()({ description: '重试失败的后台任务', params: [id()] })
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
  chat: {
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
        ['patch', z.object({ title: z.string().max(200).optional(), scope: S.ChatScopeSchema.optional(), pinned: z.boolean().optional() })]
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
  goals: {
    list: cap<Goal[]>()({ description: '列出学习目标', params: none }),
    save: cap<Goal>()({ description: '新建或修改学习目标', params: [['input', S.GoalInputSchema]] }),
    remove: cap<void>()({ description: '删除学习目标', params: [id()] }),
    progress: cap<GoalProgress>()({ description: '学习目标的进度（笔记、卡片、掌握比例、近 7 天复习）', params: [id()] }),
    linkNote: cap<Goal>()({ description: '把笔记关联到目标或取消关联', params: [id(), id('noteId'), ['linked', z.boolean()]] })
  },
  connections: {
    get: cap<NoteConnections>()({
      description: '笔记的关联：反向链接、手动关联、相关推荐、未链接的提及',
      params: [id('noteId')],
      ai: { effect: 'read' }
    }),
    relate: cap<void>()({
      description: '把笔记与另一篇笔记或资料关联（双向）',
      params: [id('noteId'), ['toType', z.enum(['note', 'source'])], id('toId')]
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
    data: cap<KnowledgeGraph>()({ description: '知识结构图：笔记、资料与它们之间的链接、关联、出处', params: none, ai: { effect: 'read' } })
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
    finish: cap<FeynmanReport>()({ description: '结束费曼练习并诊断：讲清楚了什么、漏洞、错误、建议的复习问题', params: [id()] }),
    addCues: cap<{ noteId: string; created: boolean }>()({
      description: '把选中的复习问题补进笔记（成为复习卡片）',
      params: [id(), ['indices', z.array(z.number().int().min(0)).min(1).max(10)]]
    })
  },
  review: {
    next: cap<ReviewCard | null>()({
      description: '下一张要复习的卡片（exclude：本轮刚复习过的）',
      params: [['exclude', z.array(S.Id).max(500)]]
    }),
    get: cap<ReviewCard | null>()({ description: '读取一张卡片', params: [id()] }),
    stats: cap<ReviewStats>()({ description: '复习统计：到期数量、今日已复习、连续天数、记住比例', params: none }),
    rate: cap<ReviewCard | null>()({
      description: '为卡片评分（1 忘了 2 困难 3 记得 4 轻松）',
      params: [
        id(),
        ['rating', z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])],
        ['durationMs', z.number().int().min(0).optional()]
      ]
    }),
    undo: cap<ReviewCard | null>()({ description: '撤销这张卡片最近一次评分', params: [id()] }),
    suspend: cap<void>()({ description: '暂停或恢复一张卡片', params: [id(), ['suspended', z.boolean()]] }),
    forNote: cap<{ id: string; rowId: string; state: ReviewCard['state']; due: number; suspended: boolean }[]>()({
      description: '某篇笔记的复习卡片',
      params: [id('noteId')]
    }),
    check: cap<AnswerCheck>()({ description: 'AI 对照笔记检查用户的回答', params: [id(), ['answer', z.string().min(1).max(5000)]] })
  },
  skills: {
    list: cap<SkillInfo[]>()({ description: '列出技能', params: none }),
    read: cap<string>()({ description: '读取技能正文（SKILL.md）', params: [['name', z.string().max(64)]] }),
    setEnabled: cap<SkillInfo[]>()({
      description: '启用或停用技能',
      params: [
        ['name', z.string().max(64)],
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
    transcribe: cap<void>()({ description: '为视频 / 音频生成转写稿（后台任务）', params: [id('sourceId')] }),
    importSubtitles: cap<number | null>()({ description: '为视频 / 音频导入字幕文件', params: [id('sourceId')] })
  },
  browser: {
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
    refine: cap<void>()({ description: '精修完整课程录音并区分说话人', params: [id('sourceId')] })
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
    search: cap<SearchHit[]>()({
      description: '在知识库（笔记与资料）中检索与问题相关的片段，结果带时间与状态',
      params: [
        ['query', z.string().min(1).max(2000)],
        ['scope', S.ChatScopeSchema],
        ['limit', z.number().int().min(1).max(30).optional()]
      ],
      ai: { effect: 'read' }
    })
  },
  stats: {
    heatmap: cap<HeatmapDay[]>()({ description: '学习热力图数据', params: [['days', z.number().int().min(1).max(3660)]] })
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
