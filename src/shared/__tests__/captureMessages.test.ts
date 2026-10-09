import { expect, it } from 'vitest'
import zhCN from '../../renderer/src/i18n/zh-CN'
import en from '../../renderer/src/i18n/en'
import { captureMessage } from '../captureMessages'
it('keeps new main capture message keys aligned and interpolates literal user values safely', () => {
  expect(Object.keys(zhCN.captureMain).sort()).toEqual(Object.keys(en.captureMain).sort())
  for (const language of ['zh-CN', 'en']) {
    expect(captureMessage(language, 'noteTitle', { title: '{{count}} <script>' })).toContain('{{count}} <script>')
    expect(captureMessage(language, 'notificationBody', { count: 2, notes: 1, destinations: 'A', sources: 1 })).not.toContain('{{')
  }
})
