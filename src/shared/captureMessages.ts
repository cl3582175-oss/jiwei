import zhCN from '../renderer/src/i18n/zh-CN'
import en from '../renderer/src/i18n/en'

export type CaptureMessageKey = keyof typeof zhCN.captureMain
/** 仅导入纯资源对象，主进程和固定中文手机页不初始化浏览器 i18n。 */
export function captureMessage(language: string, key: CaptureMessageKey, args: Record<string, string | number> = {}): string {
  const messages = language.startsWith('zh') ? zhCN.captureMain : en.captureMain
  return messages[key].replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => String(args[name] ?? placeholder))
}
