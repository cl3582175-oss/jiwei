import { describe, expect, it } from 'vitest'
import { collectTabSources, withTabSources, type ContextTab } from '../browserTabContext'

const a: ContextTab = { id: 'a', url: 'https://course.test/a', incognito: false, sensitive: false }
const b: ContextTab = { id: 'b', url: 'https://course.test/b', incognito: false, sensitive: false }

describe('browser tab context', () => {
  it('saves each selected page and preserves distinct source identities', async () => {
    const result = await collectTabSources(
      [a, b, a],
      async () => [a, b],
      async (id) => `source-${id}`
    )
    expect(result).toEqual({
      sources: [
        { ...a, sourceId: 'source-a' },
        { ...b, sourceId: 'source-b' }
      ],
      unavailable: []
    })
    expect(withTabSources({ targets: [], sourceId: 'source-a' }, result.sources).targets).toEqual([
      { kind: 'viewport', parentType: 'source', parentId: 'source-a' },
      { kind: 'viewport', parentType: 'source', parentId: 'source-b' }
    ])
  })

  it('never saves a tab that became sensitive, incognito, closed or navigated', async () => {
    for (const tabs of [[], [{ ...a, sensitive: true }], [{ ...a, incognito: true }], [{ ...a, url: 'https://course.test/private' }]]) {
      const result = await collectTabSources(
        [a],
        async () => tabs,
        async () => {
          throw new Error('must not save')
        }
      )
      expect(result).toEqual({ sources: [], unavailable: ['a'] })
    }
  })

  it('drops a page that navigates while saveSource is in flight', async () => {
    let tabs = [a]
    const result = await collectTabSources(
      [a],
      async () => tabs,
      async () => {
        tabs = [{ ...a, url: 'https://course.test/account', sensitive: true }]
        return 'old-source'
      }
    )
    expect(result).toEqual({ sources: [], unavailable: ['a'] })
  })

  it('rechecks earlier pages after later pages have finished saving', async () => {
    let tabs = [a, b]
    const result = await collectTabSources(
      [a, b],
      async () => tabs,
      async (id) => {
        if (id === 'b') tabs = [{ ...a, sensitive: true }, b]
        return `source-${id}`
      }
    )
    expect(result.sources.map((s) => s.sourceId)).toEqual(['source-b'])
    expect(result.unavailable).toEqual(['a'])
  })

  it('keeps selections and active viewport when adding whole-page anchors', () => {
    const packet = withTabSources(
      {
        targets: [{ kind: 'note-text', parentType: 'note', parentId: 'note', quote: 'question' }],
        viewport: { kind: 'viewport', parentType: 'source', parentId: 'source-a', ownerId: 'segment-a' }
      },
      [
        { ...a, sourceId: 'source-a' },
        { ...b, sourceId: 'source-b' }
      ]
    )
    expect(packet.targets).toEqual([
      { kind: 'note-text', parentType: 'note', parentId: 'note', quote: 'question' },
      { kind: 'viewport', parentType: 'source', parentId: 'source-a', ownerId: 'segment-a' },
      { kind: 'viewport', parentType: 'source', parentId: 'source-b' }
    ])
    expect(packet.targets.length).toBeLessThanOrEqual(8)
  })
})
