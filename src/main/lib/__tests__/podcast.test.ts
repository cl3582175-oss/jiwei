import { describe, expect, it } from 'vitest'
import { podcastMaterial, podcastSchema, podcastPrompt } from '../podcast'

describe('学习播客讲稿素材', () => {
  const now = new Date(2026, 9, 11, 10).getTime()
  it('只发当天允许的精选、最早到期五张问题与一个提醒；答案不进入素材', () => {
    const input = {
      picks: [
        { id: 'allowed', title: '允许的精选', reason: '补足方向', pickedAt: now, allowed: true },
        { id: 'old', title: '昨天的精选', reason: '旧推荐', pickedAt: now - 86400000, allowed: true },
        { id: 'private', title: 'PRIVATE_PICK', reason: '私有笔记', pickedAt: now, allowed: false }
      ],
      cards: Array.from({ length: 8 }, (_, i) => ({
        id: String(i),
        question: `问题${i}`,
        answer: 'ANSWER_MUST_NOT_LEAVE',
        due: now - i * 1000,
        allowed: i !== 7
      })),
      mistakes: [
        { id: 'private', question: 'PRIVATE_MISTAKE', concepts: ['私有概念'], cause: 'concept', allowed: false },
        { id: 'ok', question: '条件何时成立？', concepts: ['条件概率'], cause: 'concept', allowed: true },
        { id: 'another', question: '第二提醒', concepts: [], cause: 'reading', allowed: true }
      ]
    }
    const material = podcastMaterial(input, now)
    expect(material.picks.map((p) => p.title)).toEqual(['允许的精选'])
    expect(material.questions.map((c) => c.question)).toEqual(['问题6', '问题5', '问题4', '问题3', '问题2'])
    expect(material.reminder?.question).toBe('条件何时成立？')
    expect(JSON.stringify(material)).not.toMatch(/ANSWER_MUST_NOT_LEAVE|PRIVATE_|第二提醒/)
  })
  it('次日到期卡不提前讲，素材缺失时不编造问题', () => {
    const material = podcastMaterial(
      { picks: [], cards: [{ id: 'later', question: '未来', due: now + 86400000, allowed: true }], mistakes: [] },
      now
    )
    expect(material).toEqual({ date: '2026-10-11', picks: [], questions: [], reminder: null })
  })
  it('结构化讲稿保持分段和约1500字，拒绝空稿和无界响应', () => {
    const valid = { paragraphs: ['甲'.repeat(500), '乙'.repeat(500), '丙'.repeat(500)] }
    expect(podcastSchema('zh-CN').parse(valid)).toEqual(valid)
    expect(podcastSchema('zh-CN').safeParse({ paragraphs: ['短'] }).success).toBe(false)
    expect(podcastSchema('zh-CN').safeParse({ paragraphs: Array.from({ length: 20 }, () => '长'.repeat(1000)) }).success).toBe(false)
    expect(podcastPrompt('zh-CN')).toContain('不提供答案')
    expect(podcastPrompt('en')).toContain('Never answer')
  })
})
