import { getSqlite } from '../db'
import { onMainEvent } from '../events'

/** 私有来源的云端处理仅随有效所属项目放行；不改变全局 ai_excluded。 */
export function recognitionScope(sourceId: string, mode: 'local' | 'cloud'): string | null {
  const sql = getSqlite()
  const source = sql.prepare('SELECT space,ai_excluded,deleted_at FROM sources WHERE id=?').get(sourceId) as
    { space: string; ai_excluded: number; deleted_at: number | null } | undefined
  if (!source || source.deleted_at !== null) return null
  if (source.space === 'library') return mode === 'cloud' && source.ai_excluded ? null : `library:${sourceId}`
  const owners = sql
    .prepare(
      `SELECT p.id,ps.created_at FROM project_sources ps
    JOIN chat_projects p ON p.id=ps.project_id AND p.deleted_at IS NULL
    WHERE ps.item_type='source' AND ps.item_id=? AND ps.origin<>'library' ORDER BY p.id`
    )
    .all(sourceId) as { id: string; created_at: number }[]
  if (owners.length === 1) return `project:${owners[0].id}:${owners[0].created_at}`
  // 保持普通附件原来的本地识别能力；无所属项目的附件仍不能后台上传云端。
  return mode === 'local' ? `attachment:${sourceId}` : null
}

/** 每次发送、重试和落库都复核，业务撤销事件立即中断在途请求。 */
export function guardRecognition(sourceId: string, mode: 'local' | 'cloud', valid: () => boolean, parent?: AbortSignal) {
  const scope = recognitionScope(sourceId, mode)
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  const canApply = (): boolean => {
    if (controller.signal.aborted) return false
    try {
      return !!scope && recognitionScope(sourceId, mode) === scope && valid()
    } catch {
      return false
    }
  }
  const check = (): void => {
    signal.throwIfAborted()
    if (!canApply()) {
      const error = new Error('Recognition access changed')
      controller.abort(error)
      throw error
    }
  }
  const refresh = (): void => {
    try {
      check()
    } catch {
      /* controller 保存撤销原因，调用边界再次抛出 */
    }
  }
  const unsubscribers = (
    ['sources:changed', 'chatProjects:changed', 'attachments:changed', 'settings:changed', 'providers:changed'] as const
  ).map((event) => onMainEvent(event, refresh))
  return { signal, check, canApply, dispose: () => unsubscribers.forEach((unsubscribe) => unsubscribe()) }
}
