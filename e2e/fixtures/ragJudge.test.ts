import { describe, expect, it } from 'vitest'
import { parseJudgement } from './ragJudge'

describe('回答评测不能把无效评分当成成功', () => {
  it('接受四个明确的 0–2 整数评分', () => {
    expect(parseJudgement('{"correct":2,"complete":1,"citations":0,"honesty":2,"reason":"引用不完整"}')?.total).toBe(5)
  })
  it('从模型的 JSON 代码围栏读取评分', () => {
    expect(parseJudgement('```json\n{"correct":1,"complete":1,"citations":1,"honesty":1,"reason":"可核对"}\n```')?.total).toBe(4)
  })
  it.each([
    '{"correct":3,"complete":1,"citations":1,"honesty":1}',
    '{"correct":1,"complete":1,"citations":1}',
    '{"correct":"2","complete":1,"citations":1,"honesty":1}',
    '{"correct":1.5,"complete":1,"citations":1,"honesty":1}',
    '这个回答非常好'
  ])('无效输出没有评分：%s', (text) => {
    expect(parseJudgement(text)).toBeNull()
  })
})
