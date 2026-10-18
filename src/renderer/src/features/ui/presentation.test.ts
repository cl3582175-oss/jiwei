import { describe, expect, it } from 'vitest'
import { samples } from '@shared/ui/__tests__/fixtures'
import { expandedLayout, markdownControls } from './presentation'

describe('expanded content sizing', () => {
  it('gives every percentage chart a definite width, including usage', () => {
    for (const type of ['chart', 'usage', 'columns', 'schedule', 'decision'] as const) expect(expandedLayout(samples[type])).toBe('wide')
  })
  it('does not impose a reading width cap on a table or SVG', () => {
    expect(expandedLayout(samples.table)).toBe('table')
    expect(expandedLayout(samples.diagram)).toBe('diagram')
    expect(expandedLayout(samples.choice)).toBe('natural')
    expect(expandedLayout(samples.form)).toBe('reading')
  })
  it('derives a sufficient composition width without changing child layout', () => {
    expect(
      expandedLayout({
        type: 'tabs',
        tabs: [
          { label: '图', children: [samples.usage] },
          { label: '短', children: [samples.choice] }
        ]
      })
    ).toBe('wide')
    expect(expandedLayout({ type: 'details', summary: '短', children: [samples.choice] })).toBe('natural')
  })
})

describe('Markdown controls inside an expanded surface', () => {
  it('retains the exact original configuration outside expansion', () => {
    const controls = { code: false, table: { copy: false, download: false, fullscreen: false } }
    expect(markdownControls(controls, false)).toBe(controls)
    expect(markdownControls(undefined, false)).toBeUndefined()
  })
  it('keeps explicit disabled controls disabled', () => {
    expect(markdownControls(false, true)).toBe(false)
    const controls = { table: false, mermaid: false }
    expect(markdownControls(controls, true)).toBe(controls)
  })
  it('only disables nested table fullscreen and retains all other choices', () => {
    const controls = {
      code: { copy: false },
      table: { copy: false, download: { filename: '原文件' }, csvSeparator: ';' as const },
      mermaid: false
    }
    expect(markdownControls(controls, true)).toEqual({ ...controls, table: { ...controls.table, fullscreen: false } })
    expect(controls.table).not.toHaveProperty('fullscreen')
    expect(markdownControls(true, true)).toEqual({ table: { fullscreen: false } })
    expect(markdownControls(undefined, true)).toEqual({ table: { fullscreen: false } })
  })
})
