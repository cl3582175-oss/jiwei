import { describe, expect, it } from 'vitest'
import { cuesToSegments, parseSubtitles } from '../subtitles'

describe('subtitles', () => {
  it('parses SRT with tags and duplicates', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:03,500\n<i>大家好</i>\n\n2\n00:00:03,500 --> 00:00:05,000\n大家好\n\n3\n00:00:06,000 --> 00:00:08,250\n今天讲间隔重复\n'
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 5, text: '大家好' },
      { start: 6, end: 8.25, text: '今天讲间隔重复' }
    ])
  })

  it('parses WebVTT with hours and cue settings', () => {
    const vtt = 'WEBVTT\n\nintro\n01:00:01.5 --> 01:00:04.000 align:start\nHello <b>world</b>\n'
    expect(parseSubtitles(vtt)).toEqual([{ start: 3601.5, end: 3604, text: 'Hello world' }])
  })

  it('merges cues into paragraphs by pause and length', () => {
    const segs = cuesToSegments([
      { start: 0, end: 2, text: '大家好，' },
      { start: 2.5, end: 5, text: '今天讲复习。' },
      { start: 10, end: 12, text: 'Next part' },
      { start: 12.2, end: 14, text: 'continues.' }
    ])
    expect(segs.map((s) => s.text)).toEqual(['大家好，今天讲复习。', 'Next part continues.'])
    expect(segs[0].locator.value).toBe('t=0,5')
    expect(segs[1].locator.value).toBe('t=10,14')
    expect(segs[0].kind).toBe('transcript')
  })
})
