import { expect, it } from 'vitest'
import { cueBodies } from '../../services/importer/cuePlan'
it('covers every empty cue beyond fifty rows, ignores existing cues and bounds each source excerpt', () => {
  const rows = Array.from({ length: 61 }, (_, i) => ({
    type: 'cornellRow',
    content: [
      {
        type: 'cornellCue',
        content: [{ type: 'paragraph', attrs: { id: `cue-${i}` }, content: i === 0 ? [{ type: 'text', text: '已有问题' }] : [] }]
      },
      { type: 'cornellBody', content: [{ type: 'paragraph', content: [{ type: 'text', text: '原创文字'.repeat(1000) }] }] }
    ]
  }))
  const result = cueBodies({ type: 'doc', content: rows })
  expect(result).toHaveLength(60)
  expect(result.at(-1)?.blockId).toBe('cue-60')
  expect(result[0].body.length).toBe(1500)
})
it('includes recognized image text for an image-only imported row', () => {
  const assetId = 'a'.repeat(64)
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'cornellRow',
        content: [
          { type: 'cornellCue', content: [{ type: 'paragraph', attrs: { id: 'cue' } }] },
          { type: 'cornellBody', content: [{ type: 'image', attrs: { id: 'picture', src: `jiwei://asset/${assetId}.png` } }] }
        ]
      }
    ]
  }
  const result = cueBodies(doc, (id) => (id === assetId ? '光合作用的产物是葡萄糖和氧气' : null), true)
  expect(result).toHaveLength(1)
  expect(result[0].body).toContain('[图片 picture]')
  expect(result[0].body).toContain('光合作用的产物是葡萄糖和氧气')
})
