import zhCN from '../../renderer/src/i18n/zh-CN'
import en from '../../renderer/src/i18n/en'
import { getSettings } from './settings'
import { VoiceValidationError } from '@shared/recording'

/** 与捕捉服务一样使用纯双语资源；后台无需初始化 renderer i18n。 */
export function voiceText(key: keyof typeof zhCN.recordingMain): string {
  return (getSettings().language.startsWith('zh') ? zhCN.recordingMain : en.recordingMain)[key]
}
export function voiceErrorText(error: unknown): string {
  if (error instanceof VoiceValidationError) return voiceText(error.key)
  const message = error instanceof Error ? error.message : String(error)
  // ffmpeg／文件系统错误可能包含解密后的临时路径；日志与界面均不暴露该路径。
  if (/[\\/]\.tmp[\\/]rec-/.test(message)) return voiceText('recordingProcessingFailed')
  return message
}
