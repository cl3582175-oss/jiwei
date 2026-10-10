import { expect, it, vi } from 'vitest'
import { voiceErrorText, voiceText } from '../../services/voiceMessages'

vi.mock('../../services/settings', () => ({ getSettings: () => ({ language: 'zh-CN' }) }))

it.each([
  "ENOENT: no such file or directory, open '/vault/.tmp/rec-a1/input.webm'",
  "精修进程失败（1）：Error opening input file /vault/.tmp/rec-moss-a1/recording.wav",
  'ENOENT: open C:\\vault\\.tmp\\rec-a1\\mic.webm'
])('日志与界面移除实际录音处理错误中的临时明文路径：%s', message => {
  expect(voiceErrorText(new Error(message))).toBe(voiceText('recordingProcessingFailed'))
})

it('保留可处理的错误说明，不暴露 Error 堆栈', () => {
  expect(voiceErrorText(new Error('恢复码不正确，请核对后重试'))).toBe('恢复码不正确，请核对后重试')
})
