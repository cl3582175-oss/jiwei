import { describe, expect, it } from 'vitest'
import { centroid, cosine, reviewSpeakers, alignSpeakers, matchPerson, trackHint } from '../voiceprint'

describe('声纹身份与不确定性', () => {
  it('按时长算中心并拒绝损坏或不匹配的向量', () => {
    expect(
      centroid([
        { embedding: [1, 0], duration: 3 },
        { embedding: [0, 1], duration: 1 }
      ])[0]
    ).toBeCloseTo(0.94868)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow()
    expect(() => centroid([{ embedding: [NaN, 0], duration: 1 }])).toThrow()
  })
  it('纠正明显错标的一句，短句继承该说话人的邻近结果', () => {
    const input = [
      { start: 0, end: 10, text: '甲', speaker: 'S01', embedding: [1, 0] },
      { start: 10, end: 20, text: '乙', speaker: 'S02', embedding: [0, 1] },
      { start: 20, end: 21.2, text: '错标乙', speaker: 'S01', embedding: [0, 1] },
      { start: 21.2, end: 21.7, text: '短句', speaker: 'S01' }
    ]
    const result = reviewSpeakers(input)
    expect(result.map((x) => x.speaker)).toEqual(['S01', 'S02', 'S02', 'S02'])
  })
  it('中心互相抵消时拿不准，正常句子保持标签', () => {
    const result = reviewSpeakers([
      { start: 0, end: 2, text: '甲', speaker: 'S01', embedding: [1, 0] },
      { start: 2, end: 4, text: '乙', speaker: 'S01', embedding: [-1, 0] },
      { start: 4, end: 7, text: '丙', speaker: 'S02', embedding: [0, 1] }
    ])
    expect(result.slice(0, 2).every((x) => x.uncertain)).toBe(true)
    expect(result[2].speaker).toBe('S02')
    expect(result[2].uncertain).toBeFalsy()
  })
  it('长错标段不能用自己拉偏的中心证明自己正确', () => {
    const result = reviewSpeakers([
      { start: 0, end: 3, text: '甲一', speaker: 'S01', embedding: [1, 0] },
      { start: 3, end: 6, text: '甲二', speaker: 'S01', embedding: [1, 0] },
      { start: 6, end: 14, text: '错标乙', speaker: 'S01', embedding: [0.65, 0.76] },
      { start: 14, end: 22, text: '乙', speaker: 'S02', embedding: [0.65, 0.76] }
    ])
    expect(result.map((s) => s.speaker)).toEqual(['S01', 'S01', 'S02', 'S02'])
  })
  it('跨块合并同一声音，一块内一对一，不合并不同声音', () => {
    const result = alignSpeakers([
      { start: 0, end: 3, text: '甲', speaker: 'S01', part: 1, embedding: [1, 0, 0] },
      { start: 3, end: 6, text: '乙', speaker: 'S02', part: 1, embedding: [0, 1, 0] },
      { start: 6, end: 9, text: '甲', speaker: 'S02', part: 2, embedding: [1, 0, 0] },
      { start: 9, end: 12, text: '丙', speaker: 'S01', part: 2, embedding: [0, 0, 1] }
    ])
    expect(result.cues.map((x) => x.speaker)).toEqual(['S01', 'S02', 'S01', 'S03'])
    expect(result.speakers).toHaveLength(3)
  })
  it('按人取最高声纹、领先差及参会人限定（包含我）', () => {
    const people = [
      {
        id: 'a',
        isMe: false,
        embeddings: [
          [1, 0],
          [0, 1]
        ]
      },
      { id: 'b', isMe: false, embeddings: [[0.99, 0.1]] },
      { id: 'me', isMe: true, embeddings: [[0, -1]] }
    ]
    expect(matchPerson([1, 0], people)).toBeNull()
    expect(matchPerson([1, 0], people, ['a'])?.personId).toBe('a')
    expect(matchPerson([0, -1], people, ['a'])?.personId).toBe('me')
    expect(matchPerson([-1, 0], people)).toBeNull()
  })
  it('分轨只提示明显来自麦克风的片段，不把混音认定为我', () => {
    expect(trackHint(0.2, 0.001)).toBe('mic')
    expect(trackHint(0.02, 0.02)).toBeUndefined()
    expect(trackHint(0.001, 0.2)).toBe('system')
  })
})
