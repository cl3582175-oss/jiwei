import { describe, expect, it } from 'vitest'
import { scanTextLayout } from '@shared/scanText'
import { deriveDoc } from '../derive'
import { markdownToNodes, nodesToMarkdown } from '../markdown'
import { DocNodeSchema } from '@shared/schemas'
import { blocksHtml, toMarkdown } from '../exportFormats'

describe('capture content', () => {
  it('maps normalized boxes to lines and excludes furniture and invalid boxes', () => {
    const lines = scanTextLayout(
      [
        { label: 'text', box: [100, 200, 900, 400], text: '第一行\n第二行' },
        { label: 'header', box: [0, 0, 1000, 100], text: 'header' },
        { label: 'text', box: [900, 0, 100, 100], text: 'bad' }
      ],
      500,
      800
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ left: 50, top: 160, width: 400, height: 80, text: '第一行' })
    expect(lines[1].top).toBe(240)
    expect(lines[0].fontSize).toBeLessThanOrEqual(48)
  })
  it('retains image-only block locations without adding OCR text to user writing', () => {
    const assetId = 'a'.repeat(64)
    const d = deriveDoc({
      type: 'doc',
      content: [
        {
          type: 'cornellRow',
          attrs: { id: 'row' },
          content: [
            { type: 'cornellBody', content: [{ type: 'image', attrs: { id: 'image-block', src: `jiwei://asset/${assetId}.png` } }] }
          ]
        }
      ]
    })
    expect(d.assetBlocks).toEqual([{ assetId, blockId: 'image-block' }])
    expect(d.plainText).toBe('')
  })
  it('round trips inline and display LaTeX including backslashes and underscores', () => {
    const md = '能量 $E=mc^2$ 和 $\\frac{x_1}{y_2}$。\n\n$$\n\\int_0^1 x^2 dx\n$$'
    const nodes = markdownToNodes(md)
    expect(nodes[0].content?.filter((n) => n.type === 'inlineMath').map((n) => n.attrs?.latex)).toEqual(['E=mc^2', '\\frac{x_1}{y_2}'])
    expect(nodes[1]).toEqual({ type: 'blockMath', attrs: { latex: '\\int_0^1 x^2 dx' } })
    expect(markdownToNodes(nodesToMarkdown(nodes))).toEqual(nodes)
    expect(
      blocksHtml(
        nodes,
        () => '',
        (s) => s
      )
    ).toContain('katex')
  })
  it('preserves formulas in cue and summary exports', () => {
    const output = toMarkdown(
      {
        type: 'doc',
        content: [
          {
            type: 'cornellRow',
            content: [
              { type: 'cornellCue', content: [{ type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: 'a^2' } }] }] },
              { type: 'cornellBody', content: [{ type: 'blockMath', attrs: { latex: 'b^2' } }] }
            ]
          },
          { type: 'cornellSummary', content: [{ type: 'blockMath', attrs: { latex: 'c^2' } }] }
        ]
      },
      {},
      { title: 'math', learnedAt: 0, lang: 'en' },
      { image: () => null, asset: (s) => s }
    )
    expect(output).toContain('## $a^2$')
    expect(output).toContain('$$\nb^2\n$$')
    expect(output).toContain('$$\nc^2\n$$')
  })
  it('validates formula payloads recursively before proposals are stored', () => {
    expect(DocNodeSchema.safeParse({ type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: 4 } }] }).success).toBe(false)
    expect(DocNodeSchema.safeParse({ type: 'blockMath', attrs: { latex: 'x^2' } }).success).toBe(true)
  })
  it('does not parse formulas inside code or escaped dollar text', () => {
    const nodes = markdownToNodes('`$x$` 和 \\$5\n\n```text\n$$x$$\n```')
    expect(JSON.stringify(nodes)).not.toContain('Math')
  })
})

describe('review regression: nested image identity', () => {
  it('keeps individual image IDs distinct from their shared retrieval container', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'cornellRow',
          attrs: { id: 'row' },
          content: [
            {
              type: 'cornellBody',
              content: [
                {
                  type: 'blockquote',
                  attrs: { id: 'quote' },
                  content: [
                    { type: 'image', attrs: { id: 'first-image', src: `jiwei://asset/${'a'.repeat(64)}.jpg` } },
                    { type: 'image', attrs: { id: 'second-image', src: `jiwei://asset/${'b'.repeat(64)}.jpg` } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
    const result = deriveDoc(doc)
    expect(result.assetImages).toEqual([
      { imageId: 'first-image', blockId: 'quote', assetId: 'a'.repeat(64) },
      { imageId: 'second-image', blockId: 'quote', assetId: 'b'.repeat(64) }
    ])
    expect(result.assetBlocks).toEqual([
      { blockId: 'quote', assetId: 'a'.repeat(64) },
      { blockId: 'quote', assetId: 'b'.repeat(64) }
    ])
  })
})
