import { expect, it } from 'vitest'
import { retrievalQuery } from '../followUp'
it('短问、代词或呢延续上一问，完整独立问题保留原文', () => {
  const prev = '前一问的主题为合成设备验收。'
  for (const text of ['价格呢？', '那这个方案怎么样？', '还有哪些条件需要做明确的对照判断？', '它们在全部验收项目之间的联系怎么解释？'])
    expect(retrievalQuery(text, prev)).toBe(text + '\n' + prev)
  expect(retrievalQuery('请从课程材料中解释实验设计与统计假设之间的关系。', prev)).toBe('请从课程材料中解释实验设计与统计假设之间的关系。')
  expect(retrievalQuery('价格呢？', null)).toBe('价格呢？')
})
it('上一问最多保留200字，空白主题不产生无意义的附加查询', () => {
  expect(retrievalQuery('价格呢？', '甲'.repeat(250))).toBe('价格呢？\n' + '甲'.repeat(200))
  expect(retrievalQuery('价格呢？', '')).toBe('价格呢？')
})
