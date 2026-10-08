import { useEffect, useMemo, useRef } from 'react'
import { Markmap } from 'markmap-view'
import { MindmapDataSchema, toTree, type MindmapTree } from '@shared/embeds/mindmap'
import { registerEmbedView, type EmbedViewProps } from './registry'

// 思维导图显示（v0.1.2：Markmap 只读渲染，可折叠、缩放）。v0.3 接入可编辑组件。

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

interface PureNode {
  content: string
  children: PureNode[]
  payload?: Record<string, unknown>
}

function toPure(t: MindmapTree): PureNode {
  return { content: escapeHtml(t.text), children: t.children.map(toPure), payload: { id: t.id, anchor: t.anchor } }
}

function MindmapView({ entry }: EmbedViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const mmRef = useRef<Markmap | null>(null)
  const json = JSON.stringify((entry.get('data') as { toJSON(): unknown } | undefined)?.toJSON?.() ?? null)
  const tree = useMemo(() => {
    const r = MindmapDataSchema.safeParse(JSON.parse(json))
    return r.success ? toTree(r.data) : null
  }, [json])

  useEffect(() => {
    if (!svgRef.current || !tree) return
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3d8a74'
    if (!mmRef.current) {
      mmRef.current = Markmap.create(svgRef.current, {
        autoFit: true,
        duration: 300,
        maxWidth: 260,
        spacingHorizontal: 64,
        initialExpandLevel: 4,
        color: () => accent
      })
    }
    void mmRef.current.setData(toPure(tree) as never).then(() => mmRef.current?.fit())
  }, [tree])

  useEffect(() => () => mmRef.current?.destroy(), [])

  if (!tree) return <div className="embed-missing">—</div>
  // 高度随叶子数自适应：每片叶子约 34px，介于 140 与 480 之间
  const leaves = (function count(t: MindmapTree): number {
    return t.children.length ? t.children.reduce((n, c) => n + count(c), 0) : 1
  })(tree)
  return <svg ref={svgRef} className="mindmap-svg" style={{ height: Math.min(480, Math.max(140, leaves * 34 + 48)) }} />
}

registerEmbedView({ kind: 'mindmap', label: 'embeds.mindmap', View: MindmapView })
