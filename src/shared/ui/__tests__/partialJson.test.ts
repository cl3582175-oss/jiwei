import { expect, it } from 'vitest'
import { parsePartialJson, PARTIAL } from '../partialJson'

it('逐字符截断嵌套 JSON，保留所有已经闭合的数组元素', () => {
  const src = JSON.stringify({ type: 'list', items: [{ text: '中"文\n' }, { text: '第二条', nested: [1, 2] }], more: { a: true } })
  const firstEnd = src.indexOf('},{') + 1
  for (let i = 0; i <= src.length; i++) {
    expect(() => parsePartialJson(src.slice(0, i))).not.toThrow()
    const r = parsePartialJson(src.slice(0, i))
    expect(r.complete).toBe(i === src.length)
    if (i >= firstEnd) expect((r.value as { items: unknown[] }).items[0]).toEqual({ text: '中"文\n' })
  }
  expect(parsePartialJson(src).value).toEqual(JSON.parse(src))
})
it('半个对象带 Symbol 标记，半个标量丢弃，不补出假的数组元素', () => {
  const r = parsePartialJson('{"items":[{"text":"完整"},{"text":"半')
  const items = (r.value as { items: Record<symbol, unknown>[] }).items
  expect(items).toHaveLength(2)
  expect(items[1][PARTIAL]).toBe(true)
  expect(parsePartialJson('[1, 2e').value).toEqual([1])
  expect(parsePartialJson('{"type":"list","ite').value).toEqual({ type: 'list' })
})
it.each(['', '{broken', '[,,,', '{"a":}'])('任意坏输入都不抛异常 %s', (src) => {
  expect(() => parsePartialJson(src)).not.toThrow()
})
