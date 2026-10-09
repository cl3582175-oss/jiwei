import { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import type { JiweiEvents } from '@shared/types'

const subscribers = new Map<keyof JiweiEvents, Set<() => void>>()

/** 服务订阅已有业务通知，避免学习档案反向依赖浏览器，也覆盖静默批处理末尾的统一广播。 */
export function onMainEvent(event: keyof JiweiEvents, listener: () => void): () => void {
  const listeners = subscribers.get(event) ?? new Set<() => void>()
  listeners.add(listener)
  subscribers.set(event, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) subscribers.delete(event)
  }
}

/** 向所有窗口广播事件 */
export function emit<K extends keyof JiweiEvents>(event: K, payload?: JiweiEvents[K]): void {
  for (const listener of [...(subscribers.get(event) ?? [])]) {
    try {
      listener()
    } catch (error) {
      // 刷新订阅者失败不能把已经持久化的操作报告成失败，也不能截断其他窗口的状态通知。
      log.warn('[events] listener failed', event, error)
    }
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(`event:${event}`, payload)
  }
}
