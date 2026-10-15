import { enqueue } from './jobs'

/** 所有解析入口复用同一去重键；自动升级才使用低谷策略。 */
export function enqueueSegment(sourceId: string, opts?: { offPeak?: boolean; upgrade?: boolean }): void {
  enqueue(
    'source.segment',
    { sourceId, ...(opts?.upgrade ? { upgrade: true } : {}) },
    {
      dedupeKey: `segment:${sourceId}`,
      offPeak: opts?.offPeak
    }
  )
}
