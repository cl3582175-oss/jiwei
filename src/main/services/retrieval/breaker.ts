import type { BackendId } from '@shared/retrieval'

// 熔断状态只在内存里：重启清空。单独成文件，配置保存时可以清除，而不必引入网关造成循环依赖。
export const failures = new Map<BackendId, number>()
export const pauses = new Map<BackendId, number>()

/** 用户改了配置（换 Key、换地址、重新启用）：之前的失败不再作数，立即恢复可用 */
export function resetBreaker(id: BackendId): void {
  failures.delete(id)
  pauses.delete(id)
}
