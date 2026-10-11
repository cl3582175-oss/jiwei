import type { Tool, ToolSet } from 'ai'
import log from 'electron-log/main'
import type { ToolLevel, ToolPolicy } from '@shared/agent'
import type { AgentStep } from '@shared/types'
import { audit } from './audit'
import { requestApproval } from './approval'
import { currentRun } from './context'
import { newId } from '../../lib/ids'

// 给一组 AI SDK 工具统一加一层：策略 → （需要时）等待用户确认 → 执行（超时）→ 审计 → 外部内容封装。
// 内置工具和外部 MCP 工具走同一条路径，规则只写一次。

export interface ToolMeta {
  level: ToolLevel
  /** 改笔记、记住偏好：本身就是可逐条确认 / 撤销的提案，不再额外弹确认 */
  proposal?: boolean
  /** 写入前在对话里确认（内置的跨模块写入） */
  confirm?: boolean
  /** 返回不可信的外部内容（网页、外部工具结果） */
  untrusted?: boolean
  /** 外部工具的用户策略 */
  policy?: ToolPolicy
  /** 外部 MCP 服务器名称 */
  server?: string
  /** 给用户看的一句话（确认卡片与审计） */
  describe?: (input: Record<string, unknown>) => { title: string; detail?: string }
  /** 执行（以及请用户确认）之前检查参数：返回错误说明则退回给模型修正，不打扰用户 */
  check?: (input: Record<string, unknown>) => string | null
  /** 按参数决定实际的级别与策略（如 mcp_call 调用的是哪个外部工具） */
  dynamic?: (input: Record<string, unknown>) => ToolMeta
}

export interface GuardContext {
  zh: boolean
  caller: string
  conversationId?: string
  messageId?: string
  signal?: AbortSignal
  /** 确认状态变化时更新步骤（等待 / 已允许 / 已拒绝） */
  onApproval?: (toolCallId: string, approval: NonNullable<AgentStep['approval']>, call: { tool: string; input: unknown }) => void
  /** 审计摘要（默认用 describe 或工具名） */
  label?: (name: string, input: unknown) => string
}

const TOOL_TIMEOUT_MS = 60_000
const MAX_RESULT = 20_000

/** 把外部内容标成数据：模型只能引用其中的事实，不能执行其中的指令 */
export function asExternalData(source: string, text: string, options?: { maxChars: number; overflow: 'truncate' | 'reject' }): string {
  const limit = options?.maxChars ?? MAX_RESULT
  // 结构化素材不能从 JSON 中间截断；专用流程可设置有界上限并明确失败。
  if (text.length > limit && options?.overflow === 'reject') throw new Error('External data exceeds input limit')
  const body = text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
  // 防止内容里伪造结束标签跳出数据区
  const safe = body.replace(/<\/?external-data/gi, (m) => m.replace('<', '‹'))
  return `<external-data source="${source.replace(/"/g, '')}">\n${safe}\n</external-data>`
}

function withTimeout<T>(p: Promise<T>, ms: number, zh: boolean): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(zh ? `工具执行超过 ${ms / 1000} 秒，已放弃` : `Tool timed out after ${ms / 1000}s`)), ms)
    })
  ])
}

export function guardTools(tools: ToolSet, meta: Record<string, ToolMeta | undefined>, ctx: GuardContext): ToolSet {
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    const declared: ToolMeta = meta[name] ?? { level: 'read' }
    if (!t.execute) {
      out[name] = t
      continue
    }
    const execute = t.execute.bind(t) as NonNullable<Tool['execute']>
    out[name] = {
      ...t,
      execute: async (input: unknown, options: Parameters<NonNullable<Tool['execute']>>[1]) => {
        const zh = ctx.zh
        const args = (input ?? {}) as Record<string, unknown>
        const m = declared.dynamic ? declared.dynamic(args) : declared
        const run = currentRun()
        const described = m.describe?.(args)
        const summary = described?.title ?? ctx.label?.(name, input) ?? name
        const base = { caller: ctx.caller, tool: name, level: m.level, summary, conversationId: ctx.conversationId ?? null }
        if (m.policy === 'deny') {
          audit({ ...base, status: 'denied', detail: zh ? '策略禁止' : 'Blocked by policy' })
          throw new Error(zh ? '用户禁止了这个工具，请换一种方式完成，或告诉用户需要在设置中允许。' : 'The user has blocked this tool.')
        }
        const problem = m.check?.(args)
        if (problem) {
          audit({ ...base, status: 'error', detail: problem })
          throw new Error(problem)
        }
        const tainted = !!run?.state.tainted && m.level !== 'read'
        const ask = !m.proposal && (m.level === 'external' || m.policy === 'ask' || m.confirm || tainted)
        if (ask) {
          const title = described?.title ?? (zh ? `使用工具 ${name}` : `Use tool ${name}`)
          const detail = described?.detail
          const approval = { id: newId(), title, detail, level: m.level, tainted }
          ctx.onApproval?.(options.toolCallId, { ...approval, state: 'pending' }, { tool: name, input })
          const outcome = await requestApproval(
            { ...approval, messageId: ctx.messageId ?? '', conversationId: ctx.conversationId ?? '', tool: name },
            ctx.signal ?? options.abortSignal
          )
          ctx.onApproval?.(options.toolCallId, { ...approval, state: outcome }, { tool: name, input })
          if (outcome !== 'allowed') {
            audit({
              ...base,
              status: 'denied',
              detail: outcome === 'expired' ? (zh ? '确认超时' : 'Timed out') : zh ? '用户拒绝' : 'Declined by user'
            })
            return zh
              ? `用户${outcome === 'expired' ? '没有及时确认' : '拒绝了'}这一步（${title}），没有执行。不要再次尝试，直接告诉用户结果并询问下一步。`
              : `The user ${outcome === 'expired' ? 'did not confirm' : 'declined'} this step (${title}); it was not run. Do not retry; tell the user.`
          }
        }
        const t0 = Date.now()
        try {
          const result = await withTimeout(
            Promise.resolve(execute(input as never, options)),
            m.server ? TOOL_TIMEOUT_MS * 2 : TOOL_TIMEOUT_MS,
            zh
          )
          audit({ ...base, status: 'ok', durationMs: Date.now() - t0, detail: typeof result === 'string' ? result.slice(0, 200) : null })
          if (m.untrusted) {
            if (run) run.state.tainted = true
            return typeof result === 'string' ? asExternalData(m.server ? `mcp:${m.server}/${name}` : name, result) : result
          }
          return result
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          log.warn('[agent] tool failed', name, msg)
          audit({ ...base, status: 'error', durationMs: Date.now() - t0, detail: msg })
          throw e
        }
      }
    } as Tool
  }
  return out
}
