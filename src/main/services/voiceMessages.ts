import zhCN from '../../renderer/src/i18n/zh-CN'
import en from '../../renderer/src/i18n/en'
import { getSettings } from './settings'
import { VoiceValidationError } from '@shared/recording'

/** 与捕捉服务一样使用纯双语资源；后台无需初始化 renderer i18n。 */
export function voiceText(key: keyof typeof zhCN.recordingMain): string {
  return (getSettings().language.startsWith('zh') ? zhCN.recordingMain : en.recordingMain)[key]
}
export function voiceErrorText(error: unknown): string {
  return error instanceof VoiceValidationError ? voiceText(error.key) : error instanceof Error ? error.message : String(error)
}
