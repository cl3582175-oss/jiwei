import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import Graph from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import { Network, Search, X, Crosshair } from 'lucide-react'
import type { GraphNode, KnowledgeGraph, MasteryStatus } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { tintFor } from '@/lib/tint'
import { FloatingPanel } from '@/components/FloatingPanel'
import { Button } from '@/components/ui/button'
import { useTokens } from '../notes/editor/embeds/VisualViews'
import { STATUS_ORDER, statusColor } from '../review/MasteryView'

// 知识结构图（v0.5.1）：sigma.js（WebGL）渲染，graphology 存图，ForceAtlas2 在 Web Worker 中布局。
// 节点：笔记（按顶级分类或掌握度着色，大小随字数）与被引用的资料；连线：正文链接、手动关联、资料出处。
// 悬停高亮邻居，点击打开；可以只看某篇笔记两步以内的“局部图”。

type ColorBy = 'category' | 'mastery'

const css = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

/** 只保留离焦点 depth 步以内的节点（连线不分方向） */
function neighborhood(g: KnowledgeGraph, focus: string, depth: number): Set<string> {
  const adj = new Map<string, string[]>()
  for (const e of g.edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
  }
  const seen = new Set([focus])
  let frontier = [focus]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const k of frontier)
      for (const n of adj.get(k) ?? [])
        if (!seen.has(n)) {
          seen.add(n)
          next.push(n)
        }
    frontier = next
  }
  return seen
}

function nodeColor(n: GraphNode, by: ColorBy, c: Record<string, string>, catColor: Map<string, string>): string {
  if (n.type === 'source') return c.subtle
  if (by === 'mastery') return statusColor(n.mastery ?? 'blank', c)
  return n.categoryId ? (catColor.get(n.categoryId) ?? c.muted) : c.muted
}

export function GraphView() {
  const { t } = useTranslation()
  const c = useTokens()
  const focus = useApp((s) => s.graphFocus)
  const { data: g } = useQuery({ queryKey: ['graph'], queryFn: () => api.graph.data(), staleTime: 0 })
  const [colorBy, setColorBy] = useState<ColorBy>('category')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const hovered = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selected

  const catColor = useMemo(
    () => new Map((g?.categories ?? []).map((cat) => [cat.id, css(`--p-${tintFor(cat.id, cat.color)}-ink`, c.muted)])),
    // 主题切换（c 变化）时重新取色
    [g, c]
  )
  const visible = useMemo(() => (g && focus && g.nodes.some((n) => n.key === focus) ? neighborhood(g, focus, 2) : null), [g, focus])
  const shown = useMemo(() => (g ? g.nodes.filter((n) => !visible || visible.has(n.key)) : []), [g, visible])
  const shownEdges = useMemo(() => (g ? g.edges.filter((e) => !visible || (visible.has(e.from) && visible.has(e.to))) : []), [g, visible])

  useEffect(() => {
    if (!g || !box.current || !shown.length) return
    const graph = new Graph({ type: 'undirected', multi: false })
    // 初始位置：同一分类聚在圆周的一段上，再交给 ForceAtlas2
    const groups = [...new Set(shown.map((n) => n.categoryId ?? n.type))]
    shown.forEach((n, i) => {
      const gi = groups.indexOf(n.categoryId ?? n.type)
      const angle = (gi / Math.max(1, groups.length)) * Math.PI * 2 + (i % 7) * 0.08
      const r = 10 + (i % 11)
      graph.addNode(n.key, {
        label: n.title || t('common.untitled'),
        x: Math.cos(angle) * r + Math.random(),
        y: Math.sin(angle) * r + Math.random(),
        size: n.type === 'source' ? 6 + Math.min(6, Math.log2(1 + n.weight)) : 8 + Math.min(12, 2 * Math.log2(1 + n.weight / 40)),
        color: nodeColor(n, colorBy, c, catColor),
        nodeType: n.type
      })
    })
    for (const e of shownEdges) {
      if (graph.hasEdge(e.from, e.to)) continue
      graph.addEdge(e.from, e.to, {
        size: e.kind === 'related' ? 1.6 : 1,
        color: e.kind === 'source' ? `${c.border}` : e.kind === 'related' ? c.accent : c.subtle
      })
    }
    const renderer = new Sigma(graph, box.current, {
      renderLabels: true,
      labelColor: { color: c.fg },
      labelSize: 12,
      labelFont: 'system-ui, sans-serif',
      // 节点不多时全部显示标题；多了只显示较大的
      labelRenderedSizeThreshold: graph.order <= 150 ? 0 : 9,
      defaultEdgeColor: c.border,
      zIndex: true,
      allowInvalidContainer: true
    })
    sigmaRef.current = renderer
    // 悬停 / 选中：只突出本节点与邻居
    const faded = c.border
    renderer.setSetting('nodeReducer', (node, data) => {
      const h = hovered.current ?? selectedRef.current
      if (!h || node === h || graph.areNeighbors(node, h)) return { ...data, zIndex: node === h ? 2 : 1, highlighted: node === h }
      return { ...data, color: faded, label: '', zIndex: 0 }
    })
    renderer.setSetting('edgeReducer', (edge, data) => {
      const h = hovered.current ?? selectedRef.current
      if (!h) return data
      return graph.hasExtremity(edge, h) ? { ...data, color: c.accent, size: 2 } : { ...data, hidden: true }
    })
    renderer.on('enterNode', ({ node }) => {
      hovered.current = node
      renderer.refresh({ skipIndexation: true })
      box.current!.style.cursor = 'pointer'
    })
    renderer.on('leaveNode', () => {
      hovered.current = null
      renderer.refresh({ skipIndexation: true })
      box.current!.style.cursor = ''
    })
    renderer.on('clickNode', ({ node }) => {
      const [type, id] = node.split(':') as ['note' | 'source', string]
      if (type === 'note') useApp.getState().openNote(id)
      else useApp.getState().openSource(id)
    })
    // 布局：Web Worker 中运行 ForceAtlas2，几秒后停止
    const layout = new FA2Layout(graph, {
      // strongGravityMode：没有连线的笔记也不会漂得太远
      settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: graph.order > 300, slowDown: 6, gravity: 0.6, strongGravityMode: true }
    })
    layout.start()
    const stop = window.setTimeout(() => layout.stop(), Math.min(6000, 1500 + graph.order * 8))
    return () => {
      window.clearTimeout(stop)
      layout.kill()
      renderer.kill()
      sigmaRef.current = null
    }
  }, [g, shown, shownEdges, colorBy, c, catColor, t])

  useEffect(() => {
    sigmaRef.current?.refresh({ skipIndexation: true })
  }, [selected])

  const matches = q.trim() ? shown.filter((n) => n.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : []
  const goTo = (key: string): void => {
    setSelected(key)
    setQ('')
    const s = sigmaRef.current
    const d = s?.getNodeDisplayData(key)
    if (s && d) void s.getCamera().animate({ x: d.x, y: d.y, ratio: 0.35 }, { duration: 500 })
  }
  const focusNode = focus ? g?.nodes.find((n) => n.key === focus) : null
  const notesN = shown.filter((n) => n.type === 'note').length

  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <Network className="size-4 text-accent" />
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('graph.title')}</h1>
        <span className="text-2xs text-subtle" data-testid="graph-count">
          {t('graph.count', { notes: notesN, sources: shown.length - notesN, edges: shownEdges.length })}
        </span>
        <div className="flex-1" />
        <div role="tablist" className="no-drag inline-flex rounded-lg bg-sunken p-0.5">
          {(['category', 'mastery'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={colorBy === k}
              onClick={() => setColorBy(k)}
              className={cn('rounded-md px-3 py-1 text-xs transition-colors', colorBy === k ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}
            >
              {t(`graph.colorBy.${k}`)}
            </button>
          ))}
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {g && !g.nodes.length ? (
          <p className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-muted">{t('graph.empty')}</p>
        ) : (
          <div ref={box} className="absolute inset-0" data-testid="graph-canvas" />
        )}
        {/* 搜索 + 局部图 */}
        <div className="absolute top-4 left-4 w-64">
          <div className="paper flex items-center gap-2 rounded-xl px-3 shadow-[var(--shadow-1)]">
            <Search className="size-3.5 text-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && matches[0] && goTo(matches[0].key)}
              placeholder={t('graph.search')}
              aria-label={t('graph.search')}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
            />
          </div>
          {matches.length > 0 && (
            <ul className="paper mt-1.5 overflow-hidden rounded-xl p-1 shadow-[var(--shadow-2)]" role="listbox" aria-label={t('graph.search')}>
              {matches.map((n) => (
                <li key={n.key}>
                  <button role="option" aria-selected={false} onClick={() => goTo(n.key)} className="w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm text-fg hover:bg-surface-hover">
                    {n.title || t('common.untitled')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {focusNode && (
            <div className="paper mt-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs shadow-[var(--shadow-1)]" data-testid="graph-focus">
              <Crosshair className="size-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-fg">{t('graph.localOf', { title: focusNode.title || t('common.untitled') })}</span>
              <button aria-label={t('graph.showAll')} onClick={() => useApp.getState().setGraphFocus(null)} className="text-subtle hover:text-fg">
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {selected && (
            <div className="paper mt-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs shadow-[var(--shadow-1)]">
              <span className="min-w-0 flex-1 truncate text-fg">{shown.find((n) => n.key === selected)?.title}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const [type, id] = selected.split(':') as ['note' | 'source', string]
                  if (type === 'note') useApp.getState().openNote(id)
                  else useApp.getState().openSource(id)
                }}
              >
                {t('graph.open')}
              </Button>
              <button aria-label={t('graph.clear')} onClick={() => setSelected(null)} className="text-subtle hover:text-fg">
                <X className="size-3.5" />
              </button>
            </div>
          )}
        </div>
        {/* 图例 */}
        {g && g.nodes.length > 0 && (
          <div className="paper absolute bottom-4 left-4 max-w-[60%] rounded-xl px-3.5 py-2.5 text-2xs text-muted shadow-[var(--shadow-1)]" data-testid="graph-legend">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {colorBy === 'mastery'
                ? (STATUS_ORDER as MasteryStatus[]).map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: statusColor(s, c) }} />
                      {t(`mastery.status.${s}`)}
                    </span>
                  ))
                : (g.categories.length ? g.categories : []).map((cat) => (
                    <span key={cat.id} className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: catColor.get(cat.id) }} />
                      {cat.name}
                    </span>
                  ))}
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: c.subtle }} />
                {t('graph.sources')}
              </span>
            </div>
            <p className="mt-1.5 text-subtle">{t('graph.hint')}</p>
          </div>
        )}
      </div>
    </FloatingPanel>
  )
}
