import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { API_SHAPE, type JiweiAPI } from '@shared/types'

// 根据 API_SHAPE 自动生成桥接对象：window.jiwei.notes.list(...) → ipc 'notes:list'
const api = Object.fromEntries(
  Object.entries(API_SHAPE).map(([ns, methods]) => [
    ns,
    Object.fromEntries(
      (methods as string[]).map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`${ns}:${m}`, ...args)])
    )
  ])
) as unknown as JiweiAPI

const platform = {
  os: process.platform,
  /** 拖拽文件获取绝对路径（Electron 32+ 移除了 File.path） */
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('jiwei', api)
contextBridge.exposeInMainWorld('platform', platform)
