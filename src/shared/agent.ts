import { z } from 'zod'

// 智能体底座（v0.7）：费用上限、工具级别与策略、确认、审计、MCP 双向。

/* ——— 费用 ——— */

const Usd = z.number().min(0).max(10_000).nullable()
/** 费用上限（美元，null 为不限）：单次回答、每天、每月 */
export const BudgetSchema = z.object({ perRun: Usd, daily: Usd, monthly: Usd })
export type Budget = z.infer<typeof BudgetSchema>
export const DEFAULT_BUDGET: Budget = { perRun: null, daily: null, monthly: null }

export interface UsageBucket {
  key: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  /** 价格未知（未计入费用）的调用次数 */
  unpriced: number
}
export interface UsageSummary {
  today: number
  month: number
  calls: number
  unpriced: number
  /** 最近 30 天，按日期升序 */
  days: { date: string; cost: number; calls: number }[]
  byPurpose: UsageBucket[]
  byModel: UsageBucket[]
  budget: Budget
  /** 今天是否已放行（达到每日 / 每月上限后用户选择“今天继续使用”） */
  overrideToday: boolean
  /** 当前是否处于超限状态 */
  blocked: 'daily' | 'monthly' | null
}

/* ——— 工具级别与策略 ——— */

export const TOOL_LEVELS = ['read', 'write', 'external'] as const
export type ToolLevel = (typeof TOOL_LEVELS)[number]
export const ToolPolicySchema = z.enum(['auto', 'ask', 'deny'])
export type ToolPolicy = z.infer<typeof ToolPolicySchema>

/** 执行中等待用户确认的一步 */
export interface ApprovalRequest {
  id: string
  messageId: string
  conversationId: string
  tool: string
  level: ToolLevel
  /** 给用户看的一句话：“新建行动项「…」，截止 10 月 15 日” */
  title: string
  /** 补充说明（参数摘要、来自哪个外部服务器） */
  detail?: string
  /** 这一步发生在读取外部内容之后 */
  tainted: boolean
}
export const ApprovalDecisionSchema = z.object({ id: z.string().max(64), allow: z.boolean() })

/* ——— 审计 ——— */

export interface AuditEntry {
  id: string
  at: number
  caller: string
  tool: string
  level: ToolLevel
  summary: string
  status: 'ok' | 'error' | 'denied'
  detail: string | null
  durationMs: number
  conversationId: string | null
}
export const AuditQuerySchema = z.object({
  caller: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(1000).optional()
})

/* ——— MCP 服务端（积微被其他应用使用） ——— */

export const McpAccessSchema = z.enum(['read', 'add', 'propose'])
export type McpAccess = z.infer<typeof McpAccessSchema>
export const McpServeSettingsSchema = z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) })
export type McpServeSettings = z.infer<typeof McpServeSettingsSchema>
export const DEFAULT_MCP_PORT = 38517

export interface McpClientInfo {
  id: string
  name: string
  access: McpAccess
  enabled: boolean
  lastUsedAt: number | null
  createdAt: number
}
export interface McpServeStatus {
  enabled: boolean
  port: number
  /** HTTP 服务是否在监听（端口被占用时为 false，并给出原因） */
  listening: boolean
  error: string | null
  url: string
  socket: string
  bridge: string
  /** 启动桥接脚本用的可执行文件（积微自带的 Node） */
  node: string
}
/** 新建或重新生成令牌后返回一次：令牌明文和各客户端的配置片段 */
export interface McpClientSecret {
  client: McpClientInfo
  token: string
  configs: { id: 'claude-desktop' | 'cursor' | 'claude-code' | 'http'; label: string; text: string }[]
}
export const McpClientCreateSchema = z.object({ name: z.string().trim().min(1).max(60), access: McpAccessSchema })
export const McpClientPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  access: McpAccessSchema.optional(),
  enabled: z.boolean().optional()
})

/* ——— MCP 客户端（积微使用外部工具） ——— */

export const McpServerInputSchema = z
  .object({
    id: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(60),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().max(1000).optional(),
    args: z.array(z.string().max(2000)).max(50).optional(),
    cwd: z.string().max(1000).nullable().optional(),
    /** 环境变量；未传表示不改，值为空字符串的键会被删除 */
    env: z.record(z.string().max(200), z.string().max(4000)).optional(),
    url: z.string().trim().max(2000).optional(),
    headers: z.record(z.string().max(200), z.string().max(4000)).optional(),
    enabled: z.boolean().optional()
  })
  .refine((v) => (v.transport === 'stdio' ? !!v.command : /^https?:\/\//i.test(v.url ?? '')), {
    message: 'stdio 需要命令，远程需要 http(s) 地址'
  })
export type McpServerInput = z.infer<typeof McpServerInputSchema>

export interface McpToolInfo {
  name: string
  title: string
  description: string
  level: ToolLevel
  policy: ToolPolicy
}
export type McpServerState = 'off' | 'idle' | 'connecting' | 'ready' | 'auth' | 'error'
export interface McpServerInfo {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string | null
  args: string[]
  cwd: string | null
  url: string | null
  /** 只给键名，不回传值 */
  envKeys: string[]
  headerKeys: string[]
  oauth: boolean
  enabled: boolean
  state: McpServerState
  error: string | null
  tools: McpToolInfo[]
}
export const McpToolPolicyInputSchema = z.object({ serverId: z.string().max(64), tool: z.string().max(200), policy: ToolPolicySchema })

/** MCP 工具注解 → 级别：只读 → read；声明无破坏、不对外 → write；其他（含没有注解）→ external */
export function levelFromAnnotations(a?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } | null): ToolLevel {
  if (a?.readOnlyHint) return 'read'
  if (a?.destructiveHint === false && a?.openWorldHint === false) return 'write'
  return 'external'
}
export const defaultPolicy = (level: ToolLevel): ToolPolicy => (level === 'read' ? 'auto' : 'ask')
/** external 不能设为自动 */
export const allowedPolicies = (level: ToolLevel): ToolPolicy[] => (level === 'external' ? ['ask', 'deny'] : ['auto', 'ask', 'deny'])
export function effectivePolicy(level: ToolLevel, stored?: ToolPolicy): ToolPolicy {
  const p = stored ?? defaultPolicy(level)
  return allowedPolicies(level).includes(p) ? p : 'ask'
}
