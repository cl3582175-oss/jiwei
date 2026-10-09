import type { BrowserWindow } from 'electron'
let main: BrowserWindow | null = null
export const getMainWindow = (): BrowserWindow | null => (main && !main.isDestroyed() ? main : null)
export function setMainWindow(win: BrowserWindow): void {
  main = win
  win.once('closed', () => {
    if (main === win) main = null
  })
}
