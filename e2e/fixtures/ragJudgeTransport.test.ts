import { expect, it } from 'vitest'
import { judgementTurns } from './ragJudgeTransport'

it('preserves a small judgement request in one ordinary app message', () => {
  const prompt = '评分规则\n<evaluation-data>{"answer":"synthetic"}</evaluation-data>'
  expect(judgementTurns(prompt)).toEqual({ preparations: [], final: prompt })
})
it('transfers every character of a large input within per-message and ten-turn history bounds', () => {
  const data = JSON.stringify({ marker: 'START-' + '合成'.repeat(20000) + '-TAIL-END' })
  const prompt = '评分规则：分数为JSON数字。\n<evaluation-data>' + data + '</evaluation-data>'
  const turn = judgementTurns(prompt)
  expect(turn.preparations.length).toBeGreaterThan(1)
  expect(turn.preparations.length).toBeLessThanOrEqual(8)
  expect([...turn.preparations, turn.final].every((t) => t.length <= 20000)).toBe(true)
  const restored = turn.preparations
    .map((t) => t.slice(t.indexOf('\n<evaluation-part>\n') + 19, t.lastIndexOf('\n</evaluation-part>')))
    .join('')
  expect(restored).toBe(prompt)
  expect(turn.final).toContain('评分规则：分数为JSON数字。')
  expect(turn.final).toContain('全部')
})
it('never splits a Unicode pair or silently exceeds the retained history', () => {
  const prompt = '规则<evaluation-data>' + 'a'.repeat(17980) + '𠀀'.repeat(10000) + '</evaluation-data>'
  const turns = judgementTurns(prompt)
  expect(turns.preparations.every((t) => !/[\uD800-\uDBFF]\n<\/evaluation-part>/.test(t))).toBe(true)
  expect(() => judgementTurns('规则<evaluation-data>' + 'x'.repeat(160000) + '</evaluation-data>')).toThrow('历史')
})
