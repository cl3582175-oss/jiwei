import { it, expect } from 'vitest'
import { mergeCaptureSettings, CaptureSettingsSchema } from '../capture'
it('merges old capture settings without resetting scheduled triage', () => {
  const s = mergeCaptureSettings({ daily: false, time: '02:45', offPeak: true }, true)
  expect(s).toMatchObject({ daily: false, time: '02:45', offPeak: true, quickShortcut: 'Alt+Command+N', sourceInfo: false })
  expect(mergeCaptureSettings({ ...s, ...CaptureSettingsSchema.parse({ quickShortcut: '' }) }, true)).toMatchObject({
    quickShortcut: '',
    time: '02:45',
    offPeak: true
  })
})
