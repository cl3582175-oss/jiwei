import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { eachCapability, type JiweiAPI } from '@shared/capabilities'
import type { JiweiEvents } from '@shared/types'

// 根据能力注册表自动生成桥接对象：window.jiwei.notes.list(...) → ipc 'notes:list'
const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {}
for (const [ns, m] of eachCapability()) {
  ;(api[ns] ??= {})[m] = (...args: unknown[]) => ipcRenderer.invoke(`${ns}:${m}`, ...args)
}

const events = {
  on<K extends keyof JiweiEvents>(event: K, cb: (payload: JiweiEvents[K]) => void): () => void {
    const listener = (_: unknown, payload: JiweiEvents[K]): void => cb(payload)
    ipcRenderer.on(`event:${event}`, listener)
    return () => ipcRenderer.removeListener(`event:${event}`, listener)
  }
}

const platform = {
  os: process.platform,
  /** 拖拽文件获取绝对路径（Electron 32+ 移除了 File.path） */
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('jiwei', api as unknown as JiweiAPI)
contextBridge.exposeInMainWorld('jiweiEvents', events)
contextBridge.exposeInMainWorld('platform', platform)
