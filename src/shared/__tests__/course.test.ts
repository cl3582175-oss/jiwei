import { describe, expect, it } from 'vitest'
import { advanceSlide, frameHash, hamming, mapChunkCues, mergeTranscript, segmentTime, supportedRows } from '../course'
import { CourseAudioSchema, CourseCaptionsSchema, CourseFrameSchema, CourseVideoSchema } from '../schemas'

describe('课程关键帧', () => {
  const frame = (flip = false): Uint8Array => Uint8Array.from({ length: 1024 }, (_, i) => (flip ? 255 - (i % 32) * 8 : (i % 32) * 8))
  it('相同画面与轻微亮度噪声不产生换页', () => {
    const a = frameHash(frame())
    expect(hamming(a.hash, frameHash(frame()).hash)).toBe(0)
    expect(hamming(a.hash, frameHash(frame().map((x) => Math.min(255, x + 2))).hash)).toBeLessThan(10)
    const first = advanceSlide(null, a, 0)
    expect(first.save).toBe(false)
    const stable = advanceSlide(first.state, a, 2)
    expect(stable.save).toBe(true)
    expect(advanceSlide(stable.state, a, 4).save).toBe(false)
  })
  it('换页须与已保存画面相差10位并稳定2秒；黑场不保存', () => {
    const a = frameHash(frame())
    const b = frameHash(frame(true))
    expect(hamming(a.hash, b.hash)).toBe(64)
    let state = advanceSlide(advanceSlide(null, a, 0).state, a, 2).state
    let r = advanceSlide(state, b, 4)
    expect(r.save).toBe(false)
    state = r.state
    expect(advanceSlide(state, b, 5).save).toBe(false)
    r = advanceSlide(state, b, 6)
    expect(r.save).toBe(true)
    expect(advanceSlide(r.state, frameHash(new Uint8Array(1024)), 8).save).toBe(false)
  })
})

describe('网页媒体消息边界', () => {
  const scope = { scope: 'page-id', media: 'media-id', url: 'https://course.test/video' }
  it('拒绝非有限时间、负数和非法播放速度，标题限制在300字', () => {
    const valid = { ...scope, currentTime: 1, duration: 40, rate: 1, paused: true, ended: false, title: '课'.repeat(400) }
    expect(CourseVideoSchema.parse(valid).title).toHaveLength(300)
    for (const patch of [{ currentTime: Infinity }, { duration: NaN }, { rate: 0 }, { currentTime: -1 }, { duration: 29 }])
      expect(CourseVideoSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })
  it('限制字幕批量、单句文字、图像和音频块大小', () => {
    const cue = { start: 0, end: 1, text: '课程' }
    expect(CourseCaptionsSchema.safeParse({ ...scope, batch: 0, done: true, cues: Array(501).fill(cue) }).success).toBe(false)
    expect(CourseCaptionsSchema.safeParse({ ...scope, batch: 0, done: true, cues: [{ ...cue, end: -1 }] }).success).toBe(false)
    expect(CourseFrameSchema.safeParse({ ...scope, t: 0, jpeg: new ArrayBuffer(1.5 * 1024 * 1024 + 1) }).success).toBe(false)
    expect(
      CourseAudioSchema.safeParse({
        ...scope,
        capture: 'capture',
        sequence: 0,
        start: 0,
        end: 10,
        rate: 1,
        elapsed: 10,
        final: false,
        bytes: new ArrayBuffer(2 * 1024 * 1024 + 1)
      }).success
    ).toBe(false)
  })
})

describe('课程分段与时间证据', () => {
  it('字幕按时间排序，替换字幕时保留网页正文与幻灯片', () => {
    const body = { kind: 'paragraph', locator: { value: 'p=1' }, text: '网页原文' }
    const slide = { kind: 'slide', locator: { value: 't=15', image: 'image-id' }, text: '' }
    const prior = { kind: 'transcript', locator: { value: 't=0,1' }, text: '旧稿' }
    const out = mergeTranscript(
      [body, prior, slide],
      [
        { start: 20, end: 25, text: '后' },
        { start: 1, end: 4, text: '前' }
      ]
    )
    expect(out.filter((x) => x.kind !== 'transcript')).toEqual([body, slide])
    expect(out.filter((x) => x.kind === 'transcript').map((x) => x.text)).toEqual(['前', '后'])
    expect(segmentTime(out.find((x) => x.text === '前')!)).toEqual([1, 4])
  })
  it('分块时间以录制起点和当时倍速换算，跳转后不能沿用前一块偏移', () => {
    const cue = [{ start: 1, end: 3, text: '提取练习' }]
    expect(mapChunkCues(cue, 100, 2)).toEqual([{ start: 102, end: 106, text: '提取练习' }])
    expect(mapChunkCues(cue, 12, 0.5)).toEqual([{ start: 12.5, end: 13.5, text: '提取练习' }])
  })
  it('只保留在真实文字稿范围±5秒内的行，拒绝非有限时间', () => {
    const transcript = [{ kind: 'transcript', locator: { value: 't=10,20' }, text: '原文' }]
    expect(supportedRows([{ t: 5 }, { t: 25 }, { t: 26 }, { t: NaN }], transcript)).toEqual([{ t: 5 }, { t: 25 }])
  })
})
