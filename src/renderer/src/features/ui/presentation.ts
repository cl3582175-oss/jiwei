import type { ControlsConfig } from 'streamdown'

export type ExpandedLayout = 'natural' | 'reading' | 'wide' | 'table' | 'diagram'
interface LayoutNode {
  type: string
  children?: readonly LayoutNode[]
  tabs?: readonly { children: readonly LayoutNode[] }[]
}

/** Percentage-sized plots need a definite parent width; other blocks keep their content size. */
export function expandedLayout<T extends LayoutNode>(node?: T): ExpandedLayout {
  if (!node) return 'reading'
  if (['chart', 'usage', 'columns', 'schedule', 'decision'].includes(node.type)) return 'wide'
  if (node.type === 'table' || node.type === 'diagram') return node.type
  if (node.type === 'tabs' || node.type === 'details')
    return expandedGroupLayout(node.type === 'tabs' ? (node.tabs?.flatMap((tab) => tab.children) ?? []) : (node.children ?? []))
  return ['stat', 'choice', 'list', 'steps', 'timeline', 'codesteps'].includes(node.type) ? 'natural' : 'reading'
}

export function expandedGroupLayout(nodes: readonly LayoutNode[]): ExpandedLayout {
  if (nodes.length === 1) return expandedLayout(nodes[0])
  const layouts = nodes.map(expandedLayout)
  if (layouts.includes('wide')) return 'wide'
  if (layouts.includes('table')) return 'table'
  if (layouts.includes('reading')) return 'reading'
  if (layouts.includes('diagram')) return 'diagram'
  return 'natural'
}

/** Preserve all caller controls and defaults; an existing fullscreen owns the available space. */
export function markdownControls(controls: ControlsConfig | undefined, expanded: boolean): ControlsConfig | undefined {
  if (!expanded || controls === false || (typeof controls === 'object' && controls.table === false)) return controls
  const original = typeof controls === 'object' ? controls : {}
  return {
    ...original,
    table: { ...(typeof original.table === 'object' ? original.table : {}), fullscreen: false }
  }
}
