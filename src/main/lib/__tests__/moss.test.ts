import { describe, expect, it } from 'vitest'
import {
  buildMossHotwords,
  mapMossToVideo,
  mergeMossChunks,
  mergeMossSegments,
  mossTranscriptRevision,
  parseMossOutput,
  parseMossRecording,
  planMossChunks
} from '../moss'

describe('MOSS output', () => {
  it('converts milliseconds and preserves speaker numbers without merging speakers', () => {
    expect(
      parseMossOutput({
        transcription: [
          { offsets: { from: 1250, to: 3500 }, speaker: '(Speaker 1) ', text: '  开始讲课。 ' },
          { offsets: { from: 4000, to: 5250 }, speaker: '(Speaker 12) ', text: '我有问题。' }
        ]
      })
    ).toEqual([
      { start: 1.25, end: 3.5, text: '开始讲课。', speaker: 'S01' },
      { start: 4, end: 5.25, text: '我有问题。', speaker: 'S12' }
    ])
  })

  it('keeps an unknown speaker unknown and ignores blank speech', () => {
    expect(
      parseMossOutput({
        transcription: [
          { offsets: { from: 0, to: 1000 }, text: '声音' },
          { offsets: { from: 1000, to: 2000 }, speaker: '', text: ' ' }
        ]
      })
    ).toEqual([{ start: 0, end: 1, text: '声音', speaker: null }])
  })

  it.each([
    {},
    { transcription: 'not an array' },
    { transcription: [{ offsets: { from: -1, to: 1000 }, text: '错误' }] },
    { transcription: [{ offsets: { from: 2000, to: 1000 }, text: '错误' }] },
    { transcription: [{ offsets: { from: 0, to: Number.NaN }, text: '错误' }] },
    { transcription: [{ offsets: { from: '0', to: 1000 }, text: '错误' }] },
    { transcription: [{ offsets: { from: 0, to: 1000 }, text: 7 }] },
    { transcription: [{ offsets: { from: 0, to: 1000 }, text: '错误', speaker: '(Speaker x)' }] }
  ])('rejects malformed output instead of silently replacing a valid transcript: %j', (raw) => {
    expect(() => parseMossOutput(raw)).toThrow()
  })
})

describe('MOSS long recordings', () => {
  it('uses one pass at 85 minutes and 60 minute windows with 30 second overlap above it', () => {
    expect(planMossChunks(5100)).toEqual([{ start: 0, duration: 5100 }])
    expect(planMossChunks(5400)).toEqual([
      { start: 0, duration: 3600 },
      { start: 3570, duration: 1830 }
    ])
    expect(() => planMossChunks(0)).toThrow()
  })

  it('offsets later chunks, removes overlapping speech once, and keeps later repetitions', () => {
    const merged = mergeMossChunks([
      {
        chunk: { start: 0, duration: 3600 },
        cues: [{ start: 3578, end: 3598, text: '同一句话。', speaker: 'S01' }]
      },
      {
        chunk: { start: 3570, duration: 1830 },
        cues: [
          { start: 5, end: 20, text: '同一句话。', speaker: 'S02' },
          { start: 35, end: 40, text: '新内容', speaker: 'S01' },
          { start: 80, end: 85, text: '同一句话。', speaker: 'S02' }
        ]
      }
    ])
    expect(merged).toEqual([
      { start: 3578, end: 3598, text: '同一句话。', speaker: 'S01', part: 1 },
      { start: 3605, end: 3610, text: '新内容', speaker: 'S01', part: 2 },
      { start: 3650, end: 3655, text: '同一句话。', speaker: 'S02', part: 2 }
    ])
  })

  it('uses one ownership boundary when overlapping passes transcribe differently', () => {
    expect(
      mergeMossChunks([
        {
          chunk: { start: 0, duration: 3600 },
          cues: [
            { start: 3574, end: 3580, text: '前半段', speaker: 'S01' },
            { start: 3590, end: 3599, text: '边缘误差', speaker: 'S01' }
          ]
        },
        {
          chunk: { start: 3570, duration: 1830 },
          cues: [
            { start: 4, end: 10, text: '前段误差', speaker: 'S02' },
            { start: 20, end: 29, text: '后半段', speaker: 'S02' }
          ]
        }
      ]).map((cue) => cue.text)
    ).toEqual(['前半段', '后半段'])
  })
})

describe('MOSS recording timeline', () => {
  const recording = {
    version: 1,
    complete: true,
    duration: 30,
    chunks: [
      { audioStart: 0, audioEnd: 10, videoStart: 0, rate: 2 },
      { audioStart: 10, audioEnd: 20, videoStart: 20, rate: 1 }
    ]
  }

  it('maps the recording clock to the video clock across speed changes', () => {
    const manifest = parseMossRecording(recording)
    expect(mapMossToVideo([{ start: 8, end: 12, text: '跨倍速', speaker: 'S01' }], manifest)).toEqual([
      { start: 16, end: 22, text: '跨倍速', speaker: 'S01' }
    ])
  })

  it('rejects incomplete, discontinuous, and shortened recordings', () => {
    expect(() => parseMossRecording({ ...recording, complete: false })).toThrow()
    expect(() => parseMossRecording({ ...recording, duration: 50 })).toThrow()
    expect(() => parseMossRecording({ ...recording, chunks: [{ audioStart: 0, audioEnd: 10, videoStart: 4, rate: 1 }] })).toThrow()
    expect(() =>
      parseMossRecording({
        ...recording,
        chunks: [recording.chunks[0], { audioStart: 12, audioEnd: 20, videoStart: 22, rate: 1 }]
      })
    ).toThrow()
  })

  it('rejects engine timestamps outside the captured audio', () => {
    expect(() => mapMossToVideo([{ start: 30, end: 31, text: '不存在的录音', speaker: 'S01' }], parseMossRecording(recording))).toThrow()
  })
})

describe('MOSS transcript and hotwords', () => {
  it('freezes only transcript content so added slides do not invalidate a queued refinement', () => {
    const transcript = { kind: 'transcript', locator: { value: 't=0,1' }, text: '文字稿', ordinal: 1 }
    const withSlide = [
      { kind: 'slide', locator: { value: 't=0' }, text: '新幻灯片' },
      { ...transcript, ordinal: 2 }
    ]
    expect(mossTranscriptRevision(withSlide)).toBe('[{"locator":{"value":"t=0,1"},"text":"文字稿"}]')
    expect(mossTranscriptRevision([{ ...transcript, text: '人工改过' }])).toBe('[{"locator":{"value":"t=0,1"},"text":"人工改过"}]')
  })

  it('replaces only transcript segments and records speaker scope for split inference', () => {
    const body = { kind: 'paragraph', locator: { page: 1 }, text: '网页正文' }
    const slide = { kind: 'slide', locator: { image: 'asset-1', value: 't=15' }, text: '幻灯片' }
    const segments = mergeMossSegments(
      [body, { kind: 'transcript', locator: { value: 't=0,1' }, text: '旧文字稿' }, slide],
      [{ start: 1.25, end: 3.5, text: '新文字稿', speaker: 'S01', part: 2 }]
    )
    expect(segments).toEqual([
      body,
      slide,
      {
        kind: 'transcript',
        locator: {
          type: 'FragmentSelector',
          conformsTo: 'http://www.w3.org/TR/media-frags/',
          value: 't=1.25,3.5',
          speaker: 'S01',
          speakerPart: 2
        },
        text: '［说话人 1］新文字稿'
      }
    ])
  })

  it('builds bounded unique hotwords from concepts, title, and frequent terms', () => {
    const words = buildMossHotwords(['FSRS', '积微', 'FSRS'], '神经网络与梯度下降', ['梯度下降，神经网络。梯度下降，神经网络。'])
    expect(words.split(',').slice(0, 2)).toEqual(['FSRS', '积微'])
    expect(words).toContain('神经')
    expect(new Set(words.split(',')).size).toBe(words.split(',').length)
    expect(
      buildMossHotwords(
        Array.from({ length: 40 }, (_, i) => `术语${i}`),
        '',
        []
      ).split(',')
    ).toHaveLength(30)
    expect(buildMossHotwords(['', '，', '\n', 'a,b'], '', []).split(',').filter(Boolean)).toEqual(['a b'])
  })
})
