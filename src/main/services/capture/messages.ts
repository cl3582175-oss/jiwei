import { captureMessage, type CaptureMessageKey } from '@shared/captureMessages'
import { getSettings } from '../settings'
export function captureText(key: CaptureMessageKey, args?: Record<string, string | number>): string {
  return captureMessage(getSettings().language, key, args)
}
