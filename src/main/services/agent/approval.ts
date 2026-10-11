import { newId } from '../../lib/ids'
import { emit } from '../../events'
import type { ApprovalRequest } from '@shared/agent'

// 执行中等待用户确认：工具在执行前挂起，界面上出现确认卡片，用户允许或拒绝后继续。
// 10 分钟没有回应视为拒绝；停止生成时一并取消。

const TIMEOUT_MS = 10 * 60_000

export type ApprovalOutcome = 'allowed' | 'denied' | 'expired'

interface Pending {
  req: ApprovalRequest
  done: (outcome: ApprovalOutcome) => void
}
const pending = new Map<string, Pending>()

export function requestApproval(input: Omit<ApprovalRequest, 'id'> & { id?: string }, signal?: AbortSignal): Promise<ApprovalOutcome> {
  const req: ApprovalRequest = { ...input, id: input.id ?? newId() }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (outcome: ApprovalOutcome): void => {
      if (!pending.has(req.id)) return
      pending.delete(req.id)
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      emit('agent:approval-done', { id: req.id, messageId: req.messageId, allow: outcome === 'allowed' })
      resolve(outcome)
    }
    const onAbort = (): void => finish('denied')
    if (signal?.aborted) return resolve('denied')
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish('expired'), TIMEOUT_MS)
    pending.set(req.id, { req, done: finish })
    emit('agent:approval', req)
  })
}

/** 用户在确认卡片上点了允许 / 拒绝 */
export function decide(id: string, allow: boolean): boolean {
  const p = pending.get(id)
  if (!p) return false
  p.done(allow ? 'allowed' : 'denied')
  return true
}

export function pendingApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.req)
}

/** 测试与退出时：拒绝全部等待中的确认 */
export function denyAll(): void {
  for (const p of [...pending.values()]) p.done('denied')
}
