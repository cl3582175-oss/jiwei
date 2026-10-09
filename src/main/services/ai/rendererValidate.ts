import { getMainWindow } from '../../mainWindow'
import log from 'electron-log/main'

// 某些数据只有渲染进程能校验（如 Mermaid 语法需要浏览器环境）：主进程请渲染进程代为校验。
// 渲染进程在 window.__jiweiValidate 上提供校验函数；没有窗口或校验失败时视为通过（显示时仍会兜底）。

export async function validateInRenderer(kind: string, data: unknown): Promise<string | null> {
  const win = getMainWindow()
  if (!win) return null
  try {
    const r = (await win.webContents.executeJavaScript(
      `window.__jiweiValidate ? window.__jiweiValidate(${JSON.stringify(kind)}, ${JSON.stringify(data)}) : null`,
      true
    )) as string | null
    return typeof r === 'string' ? r : null
  } catch (e) {
    log.warn('[validate] renderer validation unavailable', e)
    return null
  }
}
