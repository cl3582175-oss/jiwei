import { expect, it } from 'vitest'
import { appendRecordingPart, parseRecordingManifest, partName } from '../recording'
import { rewriteSpeakerText, correctionPair, transcriptExport } from '@shared/recording'
import { buildMossHotwords, MOSS_HOTWORD_MAX_BYTES } from '../moss'

const id = '62167ca2-6f54-4423-9fc2-80a3528c03f2'
const part = { track: 'mic' as const, sequence: 0, startMs: 0, durationMs: 10000, size: 16, sha256: 'a'.repeat(64) }
it('拒绝路径穿越、非法轨道和分块序号', () => {
  expect(partName('mic', 1)).toBe('mic-000001.webm')
  expect(() => partName('../system', 0)).toThrow()
  expect(() => partName('mic', -1)).toThrow()
  expect(() => parseRecordingManifest({ version: 1, id: '../x', tracks: ['mic'], parts: [] })).toThrow()
})
it('恢复清单要求连续块，完全相同重传幂等，坏块与冲突重复拒绝', () => {
  const manifest = parseRecordingManifest({ version: 1, id, tracks: ['mic'], parts: [] })
  const added = appendRecordingPart(manifest, part)
  expect(appendRecordingPart(added, part).parts).toHaveLength(1)
  expect(() => appendRecordingPart(added, { ...part, sha256: 'b'.repeat(64) })).toThrow()
  expect(() => appendRecordingPart(added, { ...part, sequence: 2 })).toThrow()
  expect(() => parseRecordingManifest({ ...added, parts: [{ ...part, size: 9 * 1024 * 1024 }] })).toThrow()
})
it('重写说话人前缀保留正文，最小纠错只登记有效词对', () => {
  expect(rewriteSpeakerText('［说话人 2］积威使用 FSRS。', 'S02', '王老师')).toBe('［王老师］积威使用 FSRS。')
  expect(rewriteSpeakerText('［王老师］积微使用 FSRS。', 'S02', null)).toBe('［说话人 2］积微使用 FSRS。')
  expect(correctionPair('今天用积威学习', '今天用积微学习')).toEqual({ from: '积威', to: '积微' })
  expect(correctionPair('你好', '你好啊')).toBeNull()
})
it('导出正文与人名、时间，不泄漏声纹向量', () => {
  const cues = [{ text: '［王老师］积微', locator: { value: 't=3,6', speaker: 'S01' } }]
  expect(transcriptExport(cues, 'md')).toBe('**王老师** [0:03] 积微\n')
  expect(transcriptExport(cues, 'srt')).toContain('00:00:03,000 --> 00:00:06,000\n王老师：积微')
})
it('热词按手填、人名、纠错、知识库优先并去重与限制 UTF-8 字节', () => {
  const words = buildMossHotwords(['FSRS'], '积微 课堂', [''], { extra: ['手填', 'FSRS'], people: ['王老师'], corrections: ['积微'] })
  expect(words.split(',').slice(0, 4)).toEqual(['手填', 'FSRS', '王老师', '积微'])
  const long = buildMossHotwords(
    Array.from({ length: 200 }, (_, i) => `很长的术语名字${i}`),
    '',
    []
  )
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(MOSS_HOTWORD_MAX_BYTES)
})
