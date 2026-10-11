import { and, desc, eq, lt } from 'drizzle-orm'
import { getDb } from '../../db'
import { agentAudit } from '../../db/schema'
import { newId } from '../../lib/ids'
import { emit } from '../../events'
import type { AuditEntry, ToolLevel } from '@shared/agent'

// 审计日志：助手每次调用工具、外部应用每次通过 MCP 访问积微，都记一条。
// 只记摘要（做了什么、结果如何），不记完整参数和返回内容，避免把笔记正文复制一份到日志里。

const KEEP_DAYS = 180
const clip = (s: string | null | undefined, n: number): string | null => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null)

let lastEmit = 0
export function audit(entry: {
  caller: string
  tool: string
  level: ToolLevel
  summary: string
  status: AuditEntry['status']
  detail?: string | null
  durationMs?: number
  conversationId?: string | null
}): void {
  getDb()
    .insert(agentAudit)
    .values({
      id: newId(),
      at: Date.now(),
      caller: entry.caller.slice(0, 100),
      tool: entry.tool.slice(0, 200),
      level: entry.level,
      summary: clip(entry.summary, 300) ?? entry.tool,
      status: entry.status,
      detail: clip(entry.detail, 500),
      durationMs: Math.round(entry.durationMs ?? 0),
      conversationId: entry.conversationId ?? null
    })
    .run()
  if (Date.now() - lastEmit > 500) {
    lastEmit = Date.now()
    emit('agent:audit', {})
  }
}

export function listAudit(q: { caller?: string; limit?: number } = {}): AuditEntry[] {
  return getDb()
    .select()
    .from(agentAudit)
    .where(q.caller ? eq(agentAudit.caller, q.caller) : undefined)
    .orderBy(desc(agentAudit.at))
    .limit(q.limit ?? 200)
    .all()
}

/** 出现过的调用方（用于筛选） */
export function auditCallers(): string[] {
  return getDb()
    .selectDistinct({ caller: agentAudit.caller })
    .from(agentAudit)
    .all()
    .map((r) => r.caller)
    .sort()
}

export function clearAudit(): void {
  getDb().delete(agentAudit).run()
  emit('agent:audit', {})
}

export function pruneAudit(): void {
  getDb()
    .delete(agentAudit)
    .where(and(lt(agentAudit.at, Date.now() - KEEP_DAYS * 86_400_000)))
    .run()
}
