import { BrowserWindow } from 'electron'
import type { JiweiEvents } from '@shared/types'

/** 向所有窗口广播事件 */
export function emit<K extends keyof JiweiEvents>(event: K, payload?: JiweiEvents[K]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(`event:${event}`, payload)
  }
}
