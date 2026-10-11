import { describe, expect, it } from 'vitest'
import { noRefs, stripLeadingTitle } from '../works'

describe('stripLeadingTitle', () => {
  it('去掉正文开头重复的本节标题', () => {
    expect(stripLeadingTitle('## 三、间隔重复：在“快要忘记”时复习\n\n如果提取练习……', '三、间隔重复：在“快要忘记”时复习')).toBe(
      '如果提取练习……'
    )
    expect(stripLeadingTitle('**间隔重复怎么用**\n正文', '间隔重复怎么用')).toBe('正文')
    expect(stripLeadingTitle('先做个测试。\n第二段', '提取练习')).toBe('先做个测试。\n第二段')
  })
})

describe('noRefs', () => {
  it('去掉要点里的素材编号', () => {
    expect(noRefs('艾宾浩斯发现：学习后 20 分钟约忘掉 42%（M6）。')).toBe('艾宾浩斯发现：学习后 20 分钟约忘掉 42%。')
    expect(noRefs('不看书，主动回忆答案（M1、M2）')).toBe('不看书，主动回忆答案')
    expect(noRefs('间隔逐渐拉长 [M3]')).toBe('间隔逐渐拉长')
  })
})
