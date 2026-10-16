import { enqueue, patchQueuedPayload, runJobNow } from './jobs'

/** 所有解析入口复用同一去重键；自动升级才使用低谷策略。 */
export function enqueueSegment(sourceId: string, opts?: { offPeak?: boolean; upgrade?: boolean }): void {
  const jobId = enqueue(
    'source.segment',
    { sourceId, ...(opts?.upgrade ? { upgrade: true } : {}) },
    {
      dedupeKey: `segment:${sourceId}`,
      offPeak: opts?.offPeak
    }
  )
  // 显式读取覆盖尚未运行的自动升级策略；运行中的尝试仍由 enqueue 的去重边界保护。
  if (!opts?.upgrade && !opts?.offPeak && patchQueuedPayload(jobId, { upgrade: false })) runJobNow(jobId)
}
