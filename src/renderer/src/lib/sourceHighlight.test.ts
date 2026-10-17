import { expect, it } from 'vitest'
import { resolveSourceHighlight } from './sourceHighlight'
import type { Segment } from '@shared/types'
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

it('resolves the real source, page range and text from a permanent segment alias', async () => {
  const segment: Segment = {
    id: 'new',
    sourceId: 'source',
    ordinal: 0,
    kind: 'paragraph',
    text: 'Exact source evidence',
    locator: { value: 'page=3', pageEnd: 4 }
  }
  expect(await resolveSourceHighlight({ type: 'segment', id: 'old', sourceId: 'source' }, async () => segment)).toEqual({
    type: 'segment',
    id: 'new',
    sourceId: 'source',
    locator: 'page=3',
    selector: { ownerId: 'new', quote: 'Exact source evidence', page: 3, pageEnd: 4 }
  })
})

it('does not use text from a segment belonging to a different target file', async () => {
  const segment: Segment = {
    id: 'other',
    sourceId: 'other-source',
    ordinal: 0,
    kind: 'paragraph',
    text: 'Unrelated evidence',
    locator: { value: 'page=9' }
  }
  const result = await resolveSourceHighlight({ type: 'segment', id: 'old', sourceId: 'source', locator: 'page=3' }, async () => segment)
  expect(result).toEqual({ type: 'segment', id: '', sourceId: 'source', locator: 'page=3' })
})
