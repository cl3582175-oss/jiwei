import { expect, it } from 'vitest'
import { resolveSourceHighlight } from './sourceHighlight'
it('历史片段别名跳到新片段，解析不到时仍保留原页定位', async () => {
  expect(await resolveSourceHighlight({ type: 'segment', id: 'old', locator: 'page=3' }, async () => 'new')).toEqual({
    type: 'segment',
    id: 'new',
    locator: 'page=3'
  })
  expect(await resolveSourceHighlight({ type: 'segment', id: 'missing', locator: 'page=3' }, async () => null)).toEqual({
    type: 'segment',
    id: '',
    locator: 'page=3'
  })
  expect(
    await resolveSourceHighlight({ type: 'block', id: 'row' }, async () => {
      throw new Error('不应调用')
    })
  ).toEqual({ type: 'block', id: 'row' })
})
