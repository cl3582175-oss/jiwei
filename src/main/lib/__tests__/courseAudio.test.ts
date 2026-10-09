import { describe, expect, it } from 'vitest'
import { appendCourseAudioPart, courseAudioManifest, hasAppliedAudioPart, type CourseAudioPart } from '../courseAudio'

const part = (sequence: number, start: number, audioDuration: number, rate = 1, final = false): CourseAudioPart => ({
  sequence,
  start,
  end: start + audioDuration * rate,
  rate,
  elapsed: audioDuration,
  audioDuration,
  final
})

describe('完整网课录音', () => {
  it('接受暂停恢复后的连续视频时间，并记录倍速映射', () => {
    expect(courseAudioManifest([part(0, 0, 10, 2), part(1, 20, 20, 1, true)], 40)).toEqual({
      version: 1,
      complete: true,
      duration: 40,
      chunks: [
        { audioStart: 0, audioEnd: 10, videoStart: 0, rate: 2 },
        { audioStart: 10, audioEnd: 30, videoStart: 20, rate: 1 }
      ]
    })
  })

  it('拒绝缺块、跳转、未结束、截断和解码时长错误', () => {
    const valid = [part(0, 0, 20), part(1, 20, 20, 1, true)]
    const invalid = [
      [part(0, 0, 20), part(2, 20, 20, 1, true)],
      [part(0, 0, 10), part(1, 20, 20, 1, true)],
      [part(0, 0, 25), part(1, 20, 20, 1, true)],
      [part(0, 0, 20), part(1, 20, 20)],
      [part(0, 0, 20), part(1, 20, 15, 1, true)],
      [{ ...valid[0], elapsed: 30 }, valid[1]],
      [{ ...valid[0], audioDuration: Number.NaN }, valid[1]],
      [{ ...valid[0], final: true }, valid[1]],
      [part(0, 3, 17), valid[1]]
    ]
    for (const parts of invalid) expect(courseAudioManifest(parts, 40).complete).toBe(false)
  })

  it('不能把每个边界的小缺口累积成数秒漏录后仍宣告完整', () => {
    const parts = Array.from({ length: 10 }, (_, i) => part(i, i * 4.4, 4, 1, i === 9))
    expect(courseAudioManifest(parts, 43.6).complete).toBe(false)
  })

  it('容忍短暂编码边界延迟，但不伪造未解码的音频', () => {
    expect(courseAudioManifest([part(0, 0.01, 19.98), part(1, 20, 19.99, 1, true)], 40).complete).toBe(true)
    expect(courseAudioManifest([part(0, 0, 0, 1, true)], 40).complete).toBe(false)
  })
})

describe('录音块幂等落库', () => {
  it('以capture和sequence识别已写入的块，人工修改文字后仍不能重放原句', () => {
    const current = [{ kind: 'transcript', locator: { value: 't=1,2', audioCapture: 'recording-a', audioSequence: 4 }, text: '人工修正' }]
    expect(hasAppliedAudioPart(current, 'recording-a', 4)).toBe(true)
    expect(hasAppliedAudioPart(current, 'recording-b', 4)).toBe(false)
    expect(hasAppliedAudioPart(current, 'recording-a', 5)).toBe(false)
  })

  it('回跳后按视频时间追加，保留人工修正文、原定位与非转写分段', () => {
    const edited = { kind: 'transcript', locator: { value: 't=30,35', audioCapture: 'old', audioSequence: 3 }, text: '人工修正' }
    const body = { kind: 'text', locator: { value: 'body' }, text: '网页正文' }
    const slide = { kind: 'slide', locator: { value: 't=20', image: 'slide-1' }, text: '幻灯片' }
    const result = appendCourseAudioPart([body, edited, slide], [{ start: 1, end: 2, text: '回听内容' }], part(0, 10, 5, 2), 'new')
    expect(result.filter((segment) => segment.kind === 'transcript').map((segment) => segment.locator.value)).toEqual([
      't=12,14',
      't=30,35'
    ])
    expect(result).toContain(edited)
    expect(result.filter((segment) => segment.kind !== 'transcript')).toEqual([body, slide])
    expect(result.find((segment) => segment.text === '回听内容')?.locator).toMatchObject({ audioCapture: 'new', audioSequence: 0 })
  })

  it('相同时间与内容的回听结果沿用原定位，不重复插入', () => {
    const original = { kind: 'transcript', locator: { value: 't=10,12', audioCapture: 'old', audioSequence: 1 }, text: '重复内容' }
    const result = appendCourseAudioPart([original], [{ start: 0, end: 2, text: '重复内容' }], part(0, 10, 5), 'new')
    expect(result).toEqual([original])
  })
})
