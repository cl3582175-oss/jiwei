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
