import { describe, expect, it } from 'vitest'
import { podcastDialogueSchema, podcastMaterial, podcastSchema, podcastPrompt, speechChunks, speechText, zhNumber, zhNumbers } from '../podcast'

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
    // 素材少时允许短稿，不逼模型凑字数；下限只挡空稿
    expect(podcastSchema('zh-CN').safeParse({ paragraphs: ['甲'.repeat(60), '乙'.repeat(60), '丙'.repeat(60)] }).success).toBe(true)
    expect(podcastSchema('zh-CN').safeParse({ paragraphs: ['甲'.repeat(30), '乙'.repeat(30), '丙'.repeat(30)] }).success).toBe(false)
    expect(podcastSchema('zh-CN').safeParse({ paragraphs: Array.from({ length: 20 }, () => '长'.repeat(1000)) }).success).toBe(false)
    expect(podcastPrompt('zh-CN')).toContain('不提供答案')
    expect(podcastPrompt('en')).toContain('Never answer')
  })
})

describe('speechChunks', () => {
  it('按句子切分且每段不超过上限', () => {
    const text = '第一句话。'.repeat(80) + '没有标点的长句'.repeat(60)
    const chunks = speechChunks(text, 280)
    expect(chunks.every((c) => c.length <= 280)).toBe(true)
    expect(chunks.join('')).toBe(text.replace(/\s/g, ''))
    expect(speechChunks('短句。', 280)).toEqual(['短句。'])
  })
})

describe('podcastDialogueSchema', () => {
  it('要求两位主持人都发言', () => {
    const turn = (speaker: 'A' | 'B') => ({ speaker, text: '这是一段用于测试长度的对谈内容。'.repeat(10) })
    expect(podcastDialogueSchema('zh-CN').safeParse({ turns: Array.from({ length: 8 }, () => turn('A')) }).success).toBe(false)
    expect(podcastDialogueSchema('zh-CN').safeParse({ turns: Array.from({ length: 8 }, (_, i) => turn(i % 2 ? 'B' : 'A')) }).success).toBe(true)
  })
})

describe('speechText', () => {
  it('把模型不认识的破折号、引号、书名号规范为停顿', () => {
    expect(speechText('梯度下降——为什么会变慢？')).toBe('梯度下降，为什么会变慢？')
    expect(speechText('你上周记下的“学习率太大就震荡”那条笔记')).toBe('你上周记下的学习率太大就震荡那条笔记')
    expect(speechText('读《线性代数》：第三章……')).toBe('读线性代数，第三章，')
    expect(speechText('想一想——。')).toBe('想一想。')
  })
})

describe('zhNumbers', () => {
  it('数字按中文读法', () => {
    expect(zhNumber(0)).toBe('零')
    expect(zhNumber(10)).toBe('十')
    expect(zhNumber(12)).toBe('十二')
    expect(zhNumber(105)).toBe('一百零五')
    expect(zhNumber(1010)).toBe('一千零一十')
    expect(zhNumber(10005)).toBe('一万零五')
    expect(zhNumber(230000)).toBe('二十三万')
    expect(zhNumber(1200300)).toBe('一百二十万零三百')
    expect(zhNumbers('今天是2026年10月12日')).toBe('今天是二零二六年十月十二日')
    expect(zhNumbers('准确率提升到95.5%')).toBe('准确率提升到百分之九十五点五')
    expect(zhNumbers('晚上9:30开始，第3张卡')).toBe('晚上九点三十分开始，第三张卡')
    expect(speechText('还有 70 天')).toBe('还有 七十 天')
    expect(speechText('Attention is all you need 2017')).toBe('Attention is all you need 2017')
  })
})
