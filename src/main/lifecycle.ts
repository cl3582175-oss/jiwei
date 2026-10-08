import { BrowserWindow } from 'electron'

// 退出 / 重启前让渲染进程把未写入的编辑立即推送到主进程。

let waiters: (() => void)[] = []

/** 渲染进程调用 app.flushDone() 时触发 */
export function resolveFlush(): void {
  const w = waiters
  waiters = []
  w.forEach((fn) => fn())
}

export function requestRendererFlush(timeoutMs = 1500): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    waiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
    for (const w of wins) w.webContents.send('event:app:flush')
  })
}
