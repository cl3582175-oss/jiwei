import { z } from 'zod'
import * as S from './schemas'
import type {
  AppInfo,
  AssetRef,
  BackupInfo,
  BlockInfo,
  Category,
  ChatMessage,
  Conversation,
  EmbeddingStatus,
  HeatmapDay,
  ImportResult,
  Job,
  Memory,
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
  app: {
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
      params: [id(), ['opIndex', z.number().int().min(0)], ['decision', z.enum(['accepted', 'rejected'])]]
    })
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
    setProfile: cap<UserProfile>()({ description: '修改个人档案', params: [['patch', S.UserProfileSchema]] })
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
