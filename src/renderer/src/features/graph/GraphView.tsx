import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import Graph from 'graphology'
import Sigma from 'sigma'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import { Network, Search, X, Crosshair, Plus, Minus, Maximize2, Sparkles, History, Play, Pause } from 'lucide-react'
import type { MasteryStatus } from '@shared/types'
import { RELATION_META, type RelationFamily } from '@shared/graphRelations'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { FloatingPanel } from '@/components/FloatingPanel'
import { mix, useTokens } from '@/features/visuals/tokens'
import { STATUS_ORDER, statusColor } from '../review/MasteryView'
import { FAMILIES, categoryColors, convexHull, degrees, edgeStyle, hubs, neighborhood, nodeSize } from './model'
import { NodePanel } from './NodePanel'
import { RelationList } from './RelationList'
import { LearningPath } from './LearningPath'
import { DiscoverPanel } from './DiscoverPanel'
import { relationOptions } from './NodePanel'

// 知识结构图（v0.5.1，v0.14.2 改版）：sigma.js（WebGL）渲染，graphology 存图，ForceAtlas2 在 Web Worker 中布局。
// 改版要点：分类用分类色并聚成带底色的区域，节点大小看连接数，连线按关系家族编码（前置、推理、对比……有方向的画箭头），
// 悬停卡片、点击看关系句子并可改类型，关系列表视图，可点的图例与缩放控件。设计见 docs/design/v0.14.2-knowledge-graph.md。

type ColorBy = 'category' | 'mastery'
type LabelData = { x: number; y: number; size: number; label?: string | null; hub?: boolean }
const NONE = '__none'
const ISOLATED = '__isolated'

function openNode(key: string): void {
  const [type, id] = key.split(':') as ['note' | 'source', string]
  if (type === 'note') useApp.getState().openNote(id)
  else useApp.getState().openSource(id)
}

export function GraphView() {
  const { t } = useTranslation()
  const c = useTokens()
  const focus = useApp((s) => s.graphFocus)
  const { data: g, refetch } = useQuery({ queryKey: ['graph'], queryFn: () => api.graph.data(), staleTime: 0 })
  const [colorBy, setColorBy] = useState<ColorBy>('category')
  const [view, setView] = useState<'map' | 'path' | 'list'>('map')
  const [discover, setDiscover] = useState(false)
  // 时间回放（v0.14.3）：只显示这个时间之前建立的笔记
  const [until, setUntil] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  // Shift + 拖动连线（v0.14.3）：松开在另一篇笔记上时选关系类型
  const [connect, setConnect] = useState<{ from: string; to: string; x: number; y: number } | null>(null)
  const [depth, setDepth] = useState(2)
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(new Set())
  const [hiddenFams, setHiddenFams] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const under = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const hovered = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selected
  // 布局结果按节点记住：切换着色、筛选、改关系时不重新排，图不会跳
  const positions = useRef(new Map<string, { x: number; y: number }>())

  const catColor = useMemo(() => (g ? categoryColors(g, c) : new Map<string, string>()), [g, c])
  const visible = useMemo(
    () => (g && focus && g.nodes.some((n) => n.key === focus) ? neighborhood(g, focus, depth) : null),
    [g, focus, depth]
  )
  const { shown, shownEdges } = useMemo(() => {
    if (!g) return { shown: [], shownEdges: [] }
    let nodes = g.nodes.filter(
      (n) =>
        (!visible || visible.has(n.key)) &&
        (n.type === 'source'
          ? !hiddenFams.has('source')
          : !hiddenCats.has(n.categoryId ?? NONE) && (until === null || n.createdAt <= until))
    )
    let keys = new Set(nodes.map((n) => n.key))
    const edges = g.edges.filter(
      (e) => keys.has(e.from) && keys.has(e.to) && !hiddenFams.has(e.kind === 'source' ? 'source' : RELATION_META[e.relation].family)
    )
    // 回放时资料跟着引用它的笔记出现
    if (until !== null) {
      const used = new Set(edges.flatMap((e) => [e.from, e.to]))
      nodes = nodes.filter((n) => n.type === 'note' || used.has(n.key))
      keys = new Set(nodes.map((n) => n.key))
    }
    return { shown: nodes, shownEdges: edges.filter((e) => keys.has(e.from) && keys.has(e.to)) }
  }, [g, visible, hiddenCats, hiddenFams, until])
  // 别处改了笔记或关系（笔记底部的关联面板、积微助手）时，图跟着更新
  useEffect(() => {
    let timer: number | undefined
    const off = window.jiweiEvents.on('notes:changed', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refetch(), 400)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [refetch])
  const suggestions = useMemo(() => (g?.edges ?? []).filter((e) => e.status === 'suggested').length, [g])
  const span = useMemo(() => {
    const times = (g?.nodes ?? []).filter((n) => n.type === 'note' && n.createdAt).map((n) => n.createdAt)
    return times.length ? { min: Math.min(...times), max: Math.max(...times) } : null
  }, [g])
  useEffect(() => {
    if (!playing || !span) return
    const step = Math.max(1, (span.max - span.min) / 60)
    const timer = window.setInterval(() => {
      setUntil((u) => {
        const next = (u ?? span.min) + step
        if (next >= span.max) {
          setPlaying(false)
          return span.max
        }
        return next
      })
    }, 120)
    return () => window.clearInterval(timer)
  }, [playing, span])
  const deg = useMemo(() => degrees(shownEdges), [shownEdges])
  const hubSet = useMemo(() => hubs(shown, shownEdges), [shown, shownEdges])
  const typedCount = useMemo(() => (g?.edges ?? []).filter((e) => e.relation !== 'related').length, [g])
  const byKey = useMemo(() => new Map((g?.nodes ?? []).map((n) => [n.key, n])), [g])

  useEffect(() => {
    if (!g || view !== 'map' || !box.current || !shown.length) return
    const graph = new Graph({ type: 'directed', multi: false })
    const group = (key: string): string => ((deg.get(key) ?? 0) === 0 ? ISOLATED : (byKey.get(key)?.categoryId ?? NONE))
    // 每个分类一个看不见的“锚点”，用较弱的引力把同类笔记拉到一起；没有连线的笔记聚在一处
    const groups = [...new Set(shown.filter((n) => n.type === 'note').map((n) => group(n.key)))]
    groups.forEach((k, i) => {
      const angle = (i / Math.max(1, groups.length)) * Math.PI * 2
      graph.addNode(`anchor:${k}`, { x: Math.cos(angle) * 30, y: Math.sin(angle) * 30, size: 0.1, hidden: true, label: '' })
    })
    let missing = false
    shown.forEach((n, i) => {
      const saved = positions.current.get(n.key)
      if (!saved) missing = true
      const anchor = n.type === 'note' ? (graph.getNodeAttributes(`anchor:${group(n.key)}`) as { x: number; y: number }) : { x: 0, y: 0 }
      const color =
        n.type === 'source'
          ? c.surface
          : colorBy === 'mastery'
            ? statusColor(n.mastery ?? 'blank', c)
            : n.categoryId
              ? (catColor.get(n.categoryId) ?? c.subtle)
              : mix(c.subtle, c.surface, 0.8)
      graph.addNode(n.key, {
        label: n.title || t('common.untitled'),
        x: saved?.x ?? anchor.x + Math.cos(i) * 4 + Math.random(),
        y: saved?.y ?? anchor.y + Math.sin(i) * 4 + Math.random(),
        size: nodeSize(n, deg.get(n.key) ?? 0),
        color,
        nodeType: n.type,
        hub: hubSet.has(n.key),
        stale: n.status === 'outdated' || n.status === 'disputed',
        group: n.type === 'note' ? group(n.key) : null
      })
      if (n.type === 'note') graph.addEdge(`anchor:${group(n.key)}`, n.key, { hidden: true, weight: 1.6, size: 0 })
    })
    for (const e of shownEdges) {
      if (graph.hasEdge(e.from, e.to) || graph.hasEdge(e.to, e.from)) continue
      const style = edgeStyle(e, c)
      const [s, d] = style.arrow ?? [e.from, e.to]
      graph.addEdge(s, d, {
        size: style.size,
        color: style.color,
        type: style.arrow ? 'arrow' : 'line',
        weight: 1,
        relLabel: e.kind === 'source' || e.relation === 'related' ? '' : RELATION_META[e.relation].zh
      })
    }
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif'
    const halo = (context: CanvasRenderingContext2D, data: LabelData, labelSize: number, bold: boolean): void => {
      if (!data.label) return
      const size = labelSize + (data.hub ? 1 : 0)
      context.font = `${data.hub || bold ? 600 : 500} ${size}px ${font}`
      const x = data.x + data.size + 4,
        y = data.y + size / 3
      // 标题描一圈底色，连线穿过时也看得清
      context.lineJoin = 'round'
      context.lineWidth = 4
      context.strokeStyle = c.surface
      context.strokeText(data.label, x, y)
      context.fillStyle = c.fg
      context.fillText(data.label, x, y)
    }
    const renderer = new Sigma(graph, box.current, {
      renderLabels: true,
      renderEdgeLabels: true,
      labelSize: 12,
      labelFont: font,
      labelColor: { color: c.fg },
      edgeLabelColor: { color: c.muted },
      edgeLabelSize: 11,
      edgeLabelFont: font,
      labelDensity: 1.4,
      labelGridCellSize: 70,
      labelRenderedSizeThreshold: graph.order <= 80 ? 0 : 7,
      defaultDrawNodeLabel: (ctx, data, settings) => halo(ctx, data as LabelData, settings.labelSize, false),
      defaultDrawNodeHover: (ctx, data, settings) => halo(ctx, data as LabelData, settings.labelSize, true),
      stagePadding: 48,
      minCameraRatio: 0.08,
      maxCameraRatio: 4,
      zIndex: true,
      allowInvalidContainer: true
    })
    sigmaRef.current = renderer
    // 端到端测试从画布元素上换算节点位置（只挂在这个 DOM 元素上，不是全局变量）
    ;(box.current as HTMLDivElement & { __graphPoint?: (key: string) => { x: number; y: number } | null }).__graphPoint = (key) => {
      if (!graph.hasNode(key)) return null
      const attr = graph.getNodeAttributes(key) as { x: number; y: number }
      return renderer.graphToViewport({ x: attr.x, y: attr.y })
    }
    renderer.setSetting('nodeReducer', (node, data) => {
      if (data.hidden) return data
      const h = hovered.current ?? selectedRef.current
      if (!h || node === h || graph.areNeighbors(node, h)) return { ...data, zIndex: node === h ? 2 : 1, highlighted: node === h }
      return { ...data, color: mix(data.color, c.surface, 0.18), label: '', zIndex: 0 }
    })
    renderer.setSetting('edgeReducer', (edge, data) => {
      if (data.hidden) return data
      const h = hovered.current ?? selectedRef.current
      if (!h) return { ...data, label: '' }
      return graph.hasExtremity(edge, h)
        ? { ...data, size: data.size + 0.8, label: (graph.getEdgeAttribute(edge, 'relLabel') as string) || '', zIndex: 1 }
        : { ...data, color: mix(data.color, c.surface, 0.2), size: Math.max(0.5, data.size * 0.6), label: '' }
    })

    let dragging: string | null = null
    let dragTo: { x: number; y: number } | null = null
    let scratchCanvas: HTMLCanvasElement | null = null
    const scratch = (width: number, height: number, dpr: number): CanvasRenderingContext2D => {
      scratchCanvas ??= document.createElement('canvas')
      scratchCanvas.width = Math.round(width * dpr)
      scratchCanvas.height = Math.round(height * dpr)
      const ctx = scratchCanvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return ctx
    }
    // 底层画分类区域，顶层画资料圆环与枢纽光环；跟着镜头每帧重画
    const draw = (): void => {
      const width = box.current?.clientWidth ?? 0,
        height = box.current?.clientHeight ?? 0,
        dpr = window.devicePixelRatio || 1
      for (const canvas of [under.current, over.current]) {
        if (!canvas) continue
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr)
          canvas.height = Math.round(height * dpr)
          canvas.style.width = `${width}px`
          canvas.style.height = `${height}px`
        }
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, width, height)
      }
      const h = hovered.current ?? selectedRef.current
      const at = (key: string): { x: number; y: number; r: number } | null => {
        const d = renderer.getNodeDisplayData(key)
        if (!d || d.hidden) return null
        // 显示数据的坐标已归一化，换算视口要用图坐标
        const attr = graph.getNodeAttributes(key) as { x: number; y: number }
        const p = renderer.graphToViewport({ x: attr.x, y: attr.y })
        return { x: p.x, y: p.y, r: renderer.scaleSize(d.size) }
      }
      const ctxU = under.current?.getContext('2d')
      if (ctxU && colorBy === 'category') {
        const members = new Map<string, { x: number; y: number }[]>()
        graph.forEachNode((key, attr) => {
          const k = attr.group as string | null
          if (!k || k === ISOLATED) return
          const p = at(key)
          if (p) members.set(k, [...(members.get(k) ?? []), p])
        })
        for (const [k, pts] of members) {
          const color = k === NONE ? c.subtle : (catColor.get(k) ?? c.subtle)
          const hull = convexHull(pts.map((p) => [p.x, p.y]))
          const pad = 26
          // 先在离屏画布上用不透明色画出“凸包 + 外扩”，再整体半透明叠上去，描边和填充重叠处不会变深
          const off = scratch(width, height, dpr)
          off.fillStyle = off.strokeStyle = color
          off.lineJoin = 'round'
          off.lineCap = 'round'
          off.lineWidth = pad * 2
          off.beginPath()
          hull.forEach(([x, y], i) => (i ? off.lineTo(x, y) : off.moveTo(x, y)))
          if (hull.length === 1) off.lineTo(hull[0][0] + 0.01, hull[0][1])
          off.closePath()
          off.stroke()
          if (hull.length >= 3) off.fill()
          ctxU.save()
          ctxU.globalAlpha = (h ? 0.05 : 0.1) * (c.dark ? 1.5 : 1)
          ctxU.setTransform(1, 0, 0, 1, 0, 0)
          ctxU.drawImage(off.canvas, 0, 0)
          ctxU.restore()
          if (pts.length >= 2 && k !== NONE) {
            const name = g.categories.find((cat) => cat.id === k)?.name ?? ''
            const top = hull.reduce((m, p) => (p[1] < m[1] ? p : m), hull[0])
            const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length
            ctxU.save()
            ctxU.globalAlpha = h ? 0.45 : 0.95
            ctxU.font = `600 12px ${font}`
            ctxU.textAlign = 'center'
            ctxU.fillStyle = mix(color, c.fg, 0.7)
            ctxU.fillText(name, cx, top[1] - pad - 4)
            ctxU.restore()
          }
        }
      }
      const ctxO = over.current?.getContext('2d')
      if (ctxO)
        graph.forEachNode((key, attr) => {
          if (attr.hidden || (h && key !== h && !graph.areNeighbors(key, h))) return
          const p = at(key)
          if (!p) return
          if (attr.nodeType === 'source') {
            ctxO.beginPath()
            ctxO.arc(p.x, p.y, Math.max(2, p.r - 1), 0, Math.PI * 2)
            ctxO.lineWidth = 2
            ctxO.strokeStyle = mix(c.subtle, c.fg, 0.7)
            ctxO.stroke()
          }
          if (attr.hub) {
            ctxO.beginPath()
            ctxO.arc(p.x, p.y, p.r + 3.5, 0, Math.PI * 2)
            ctxO.lineWidth = 2
            ctxO.strokeStyle = c.emph
            ctxO.stroke()
          }
          // 已过时 / 存疑的笔记：红色虚线圈
          if (attr.stale) {
            ctxO.save()
            ctxO.setLineDash([3, 3])
            ctxO.beginPath()
            ctxO.arc(p.x, p.y, p.r + (attr.hub ? 7 : 3.5), 0, Math.PI * 2)
            ctxO.lineWidth = 1.6
            ctxO.strokeStyle = c.viz[3]
            ctxO.stroke()
            ctxO.restore()
          }
        })
      // 正在拖出的连线
      if (ctxO && dragging && dragTo) {
        const p = at(dragging)
        if (p) {
          ctxO.save()
          ctxO.setLineDash([6, 4])
          ctxO.lineWidth = 2
          ctxO.strokeStyle = c.accent
          ctxO.beginPath()
          ctxO.moveTo(p.x, p.y)
          ctxO.lineTo(dragTo.x, dragTo.y)
          ctxO.stroke()
          ctxO.restore()
        }
      }
      const hk = hovered.current
      if (hk) {
        const p = at(hk)
        if (p)
          setHover((prev) =>
            prev && prev.key === hk && Math.abs(prev.x - p.x) < 0.5 && Math.abs(prev.y - p.y - p.r) < 0.5
              ? prev
              : { key: hk, x: p.x, y: p.y + p.r }
          )
      }
    }
    renderer.on('afterRender', draw)
    renderer.on('enterNode', ({ node }) => {
      hovered.current = node
      renderer.refresh({ skipIndexation: true })
      if (box.current) box.current.style.cursor = 'pointer'
    })
    renderer.on('leaveNode', () => {
      hovered.current = null
      setHover(null)
      renderer.refresh({ skipIndexation: true })
      if (box.current) box.current.style.cursor = ''
    })
    let dragged = false
    renderer.on('clickNode', ({ node }) => {
      // 拖线松手时也会触发一次点击：忽略，免得把目标笔记选中
      if (dragged) {
        dragged = false
        return
      }
      setSelected(node)
    })
    renderer.on('downNode', (e) => {
      const original = e.event.original as MouseEvent
      if (!original.shiftKey || !e.node.startsWith('note:')) return
      dragging = e.node
      e.preventSigmaDefault()
    })
    renderer.on('moveBody', ({ event }) => {
      if (!dragging) return
      dragTo = { x: event.x, y: event.y }
      event.preventSigmaDefault()
      event.original.preventDefault()
      event.original.stopPropagation()
      renderer.refresh({ skipIndexation: true })
    })
    renderer.on('upNode', ({ node }) => {
      if (dragging && node !== dragging && node.startsWith('note:') && dragTo) {
        dragged = true
        setConnect({ from: dragging, to: node, x: dragTo.x, y: dragTo.y })
      }
    })
    const endDrag = (): void => {
      if (!dragging) return
      dragging = null
      dragTo = null
      renderer.refresh({ skipIndexation: true })
    }
    renderer.on('upStage', endDrag)
    renderer.getMouseCaptor().on('mouseup', () => window.setTimeout(endDrag, 0))
    renderer.on('doubleClickNode', (e) => {
      e.preventSigmaDefault()
      openNode(e.node)
    })
    renderer.on('clickStage', () => setSelected(null))

    let layout: FA2Layout | null = null
    let stop = 0
    const save = (): void =>
      graph.forEachNode((key, attr) => {
        if (!key.startsWith('anchor:')) positions.current.set(key, { x: attr.x as number, y: attr.y as number })
      })
    if (missing) {
      layout = new FA2Layout(graph, {
        getEdgeWeight: 'weight',
        settings: {
          ...forceAtlas2.inferSettings(graph),
          barnesHutOptimize: graph.order > 300,
          slowDown: 8,
          gravity: 0.8,
          scalingRatio: 8,
          strongGravityMode: true,
          edgeWeightInfluence: 1
        }
      })
      layout.start()
      stop = window.setTimeout(
        () => {
          layout?.stop()
          save()
        },
        Math.min(5000, 1500 + graph.order * 10)
      )
    }
    return () => {
      window.clearTimeout(stop)
      if (layout) {
        layout.stop()
        save()
        layout.kill()
      }
      renderer.kill()
      sigmaRef.current = null
    }
  }, [g, view, shown, shownEdges, colorBy, c, catColor, deg, hubSet, byKey, t])

  useEffect(() => {
    sigmaRef.current?.refresh({ skipIndexation: true })
  }, [selected])

  const matches = q.trim() ? shown.filter((n) => n.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : []
  const goTo = (key: string): void => {
    setSelected(key)
    setQ('')
    if (view === 'list') setView('map')
    const s = sigmaRef.current
    const d = s?.getNodeDisplayData(key)
    if (s && d) void s.getCamera().animate({ x: d.x, y: d.y, ratio: 0.45 }, { duration: 500 })
  }
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string): void => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }
  const focusNode = focus ? g?.nodes.find((n) => n.key === focus) : null
  const notesN = shown.filter((n) => n.type === 'note').length
  const selectedNode = selected ? byKey.get(selected) : null
  const hoverNode = hover && hover.key !== selected ? byKey.get(hover.key) : null
  const camera = (fn: 'animatedZoom' | 'animatedUnzoom' | 'animatedReset'): void =>
    void sigmaRef.current?.getCamera()[fn]({ duration: 250 })
  const familySwatch = (f: RelationFamily): string =>
    edgeStyle(
      {
        from: 'a',
        to: 'b',
        kind: 'related',
        relation: f === 'structure' ? 'prerequisite' : f === 'reasoning' ? 'evidence' : f === 'tension' ? 'contrasts' : 'related',
        status: 'confirmed'
      },
      c
    ).color
  const tabs = (name: 'view' | 'colorBy', keys: readonly string[], value: string, set: (v: never) => void) => (
    <div role="tablist" className="no-drag inline-flex rounded-lg bg-sunken p-0.5">
      {keys.map((k) => (
        <button
          key={k}
          role="tab"
          aria-selected={value === k}
          onClick={() => set(k as never)}
          className={cn(
            'rounded-md px-3 py-1 text-xs transition-colors',
            value === k ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg'
          )}
        >
          {t(`graph.${name}.${k}`)}
        </button>
      ))}
    </div>
  )

  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <Network className="size-4 text-accent" />
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('graph.title')}</h1>
        <span className="text-2xs text-subtle" data-testid="graph-count">
          {t('graph.count', { notes: notesN, sources: shown.length - notesN, edges: shownEdges.length })}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => {
            setDiscover(!discover)
            setSelected(null)
          }}
          aria-pressed={discover}
          data-testid="graph-discover-toggle"
          className={cn(
            'no-drag inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-colors',
            discover ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg'
          )}
        >
          <Sparkles className="size-3.5" />
          {t('graph.discover.title')}
          {suggestions > 0 && <span className="rounded-full bg-emph px-1.5 text-2xs leading-4 text-white">{suggestions}</span>}
        </button>
        {view === 'map' && tabs('colorBy', ['category', 'mastery'], colorBy, setColorBy)}
        {tabs('view', ['map', 'path', 'list'], view, setView)}
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {g && !g.nodes.length ? (
          <p className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-muted">{t('graph.empty')}</p>
        ) : view === 'list' ? (
          <RelationList nodes={shown} edges={shownEdges} c={c} onSelect={goTo} />
        ) : view === 'path' ? (
          <LearningPath nodes={shown} edges={shownEdges} c={c} selected={selected} onSelect={setSelected} />
        ) : (
          <>
            {/* 底部留出图例的高度，节点不会被图例挡住 */}
            <canvas ref={under} className="pointer-events-none absolute inset-x-0 top-0 bottom-24" aria-hidden="true" />
            <div ref={box} className="absolute inset-x-0 top-0 bottom-24" data-testid="graph-canvas" />
            <canvas ref={over} className="pointer-events-none absolute inset-x-0 top-0 bottom-24" aria-hidden="true" />
          </>
        )}
        {/* 悬停卡片 */}
        {hoverNode && hover && view === 'map' && (
          <div
            className="paper pointer-events-none absolute z-10 w-64 rounded-xl px-3.5 py-3 shadow-[var(--shadow-2)]"
            style={{
              left: Math.max(8, Math.min(hover.x + 12, (box.current?.clientWidth ?? 0) - 270)),
              top: Math.max(8, Math.min(hover.y + 8, (box.current?.clientHeight ?? 0) - 150))
            }}
            data-testid="graph-hover"
          >
            <p className="truncate text-sm font-semibold text-fg">{hoverNode.title || t('common.untitled')}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted">
              {hoverNode.type === 'source' ? (
                <span>{t('graph.legend.source')}</span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <span
                    className="size-2 rounded-full"
                    style={{ background: hoverNode.categoryId ? catColor.get(hoverNode.categoryId) : c.subtle }}
                  />
                  {g?.categories.find((cat) => cat.id === hoverNode.categoryId)?.name ?? t('graph.legend.uncategorized')}
                </span>
              )}
              {hoverNode.mastery && (
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-full" style={{ background: statusColor(hoverNode.mastery, c) }} />
                  {t(`mastery.status.${hoverNode.mastery}`)}
                </span>
              )}
              <span>{t('graph.links', { n: deg.get(hoverNode.key) ?? 0 })}</span>
              {hubSet.has(hoverNode.key) && <span className="text-emph">{t('graph.legend.hub')}</span>}
            </div>
            {hoverNode.excerpt && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">{hoverNode.excerpt}</p>}
          </div>
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
            <ul
              className="paper mt-1.5 overflow-hidden rounded-xl p-1 shadow-[var(--shadow-2)]"
              role="listbox"
              aria-label={t('graph.search')}
            >
              {matches.map((n) => (
                <li key={n.key}>
                  <button
                    role="option"
                    aria-selected={false}
                    onClick={() => goTo(n.key)}
                    className="w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm text-fg hover:bg-surface-hover"
                  >
                    {n.title || t('common.untitled')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {focusNode && (
            <div className="paper mt-2 rounded-xl px-3 py-2 text-xs shadow-[var(--shadow-1)]" data-testid="graph-focus">
              <div className="flex items-center gap-2">
                <Crosshair className="size-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-fg">
                  {t('graph.localOf', { title: focusNode.title || t('common.untitled') })}
                </span>
                <button
                  aria-label={t('graph.showAll')}
                  onClick={() => useApp.getState().setGraphFocus(null)}
                  className="text-subtle hover:text-fg"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="mt-2 flex items-center gap-1 text-2xs text-subtle">
                <span className="mr-1">{t('graph.depth')}</span>
                {[1, 2, 3].map((n) => (
                  <button
                    key={n}
                    aria-pressed={depth === n}
                    onClick={() => setDepth(n)}
                    className={cn('rounded-md px-2 py-0.5', depth === n ? 'bg-accent-soft text-accent' : 'hover:text-fg')}
                  >
                    {t('graph.steps', { n })}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {/* 图例：点击显示 / 隐藏 */}
        {g && g.nodes.length > 0 && view === 'map' && (
          <div
            className="paper absolute bottom-4 left-4 max-w-[min(600px,60%)] rounded-xl px-3.5 py-3 text-2xs text-muted shadow-[var(--shadow-1)]"
            data-testid="graph-legend"
          >
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
              <span className="mr-1 font-medium text-subtle">
                {t(colorBy === 'mastery' ? 'graph.legend.mastery' : 'graph.legend.categories')}
              </span>
              {colorBy === 'mastery'
                ? (STATUS_ORDER as MasteryStatus[]).map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
                      <span className="size-2 rounded-full" style={{ background: statusColor(s, c) }} />
                      {t(`mastery.status.${s}`)}
                    </span>
                  ))
                : [
                    ...g.categories.map((cat) => [cat.id, cat.name, catColor.get(cat.id) ?? c.subtle] as const),
                    [NONE, t('graph.legend.uncategorized'), mix(c.subtle, c.surface, 0.8)] as const
                  ].map(([id, name, color]) => (
                    <button
                      key={id}
                      aria-pressed={!hiddenCats.has(id)}
                      title={t('graph.legend.toggle')}
                      onClick={() => toggle(hiddenCats, setHiddenCats, id)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-hover',
                        hiddenCats.has(id) && 'line-through opacity-40'
                      )}
                    >
                      <span className="size-2 rounded-full" style={{ background: color }} />
                      {name}
                    </button>
                  ))}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1">
              <span className="mr-1 font-medium text-subtle">{t('graph.legend.relations')}</span>
              {FAMILIES.map((f) => (
                <button
                  key={f}
                  aria-pressed={!hiddenFams.has(f)}
                  title={t('graph.legend.toggle')}
                  onClick={() => toggle(hiddenFams, setHiddenFams, f)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-hover',
                    hiddenFams.has(f) && 'line-through opacity-40'
                  )}
                >
                  <span className="h-[3px] w-4 rounded-full" style={{ background: familySwatch(f) }} />
                  {t(`graph.family.${f}`)}
                </button>
              ))}
              <button
                aria-pressed={!hiddenFams.has('source')}
                title={t('graph.legend.toggle')}
                onClick={() => toggle(hiddenFams, setHiddenFams, 'source')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-hover',
                  hiddenFams.has('source') && 'line-through opacity-40'
                )}
              >
                <span className="size-2.5 rounded-full border-2" style={{ borderColor: mix(c.subtle, c.fg, 0.7) }} />
                {t('graph.legend.source')}
              </button>
              {shown.some((n) => n.status === 'outdated' || n.status === 'disputed') && (
                <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
                  <span className="size-2.5 rounded-full border-2 border-dashed" style={{ borderColor: c.viz[3] }} />
                  {t('graph.legend.stale')}
                </span>
              )}
              {hubSet.size > 0 && (
                <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5" title={t('graph.hubHint')}>
                  <span className="size-2.5 rounded-full border-2" style={{ borderColor: c.emph }} />
                  {t('graph.legend.hub')}
                </span>
              )}
            </div>
            <p className="mt-2 text-subtle">{typedCount === 0 ? t('graph.typedHint') : t('graph.hint')}</p>
          </div>
        )}
        {/* 缩放控件 */}
        {view === 'map' && g && g.nodes.length > 0 && (
          <div
            className="paper absolute bottom-24 flex flex-col overflow-hidden rounded-xl shadow-[var(--shadow-1)]"
            style={{ right: selectedNode || discover ? 344 : 16 }}
          >
            {(
              [
                ['animatedZoom', Plus, 'graph.zoomIn'],
                ['animatedUnzoom', Minus, 'graph.zoomOut'],
                ['animatedReset', Maximize2, 'graph.fit']
              ] as const
            ).map(([fn, Icon, label]) => (
              <button
                key={fn}
                aria-label={t(label)}
                title={t(label)}
                onClick={() => camera(fn)}
                className="grid size-9 place-items-center text-muted hover:bg-surface-hover hover:text-fg"
              >
                <Icon className="size-4" />
              </button>
            ))}
            {span && span.max > span.min && (
              <button
                aria-label={t('graph.timeline')}
                title={t('graph.timeline')}
                aria-pressed={until !== null}
                onClick={() => {
                  if (until === null) {
                    setUntil(span.min)
                    setPlaying(true)
                  } else {
                    setUntil(null)
                    setPlaying(false)
                  }
                }}
                className={cn(
                  'grid size-9 place-items-center border-t border-border/70 hover:bg-surface-hover',
                  until !== null ? 'text-accent' : 'text-muted hover:text-fg'
                )}
              >
                <History className="size-4" />
              </button>
            )}
          </div>
        )}
        {connect && g && (
          <div
            className="paper absolute z-20 w-72 rounded-xl p-2 shadow-[var(--shadow-3)]"
            style={{
              left: Math.min(connect.x + 12, (box.current?.clientWidth ?? 300) - 300),
              top: Math.min(connect.y + 12, (box.current?.clientHeight ?? 300) - 320)
            }}
            data-testid="graph-connect"
          >
            <p className="px-2 pt-1 pb-2 text-2xs text-subtle">{t('graph.connectTitle')}</p>
            <div className="max-h-72 overflow-y-auto">
              {relationOptions(byKey.get(connect.from)?.title ?? '', byKey.get(connect.to)?.title ?? '', true).map((o) => (
                <button
                  key={o.value}
                  title={o.title}
                  className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-fg hover:bg-surface-hover"
                  onClick={async () => {
                    const [r, rev] = o.value.split('|')
                    await api.connections.relate(connect.from.slice(5), 'note', connect.to.slice(5), r as never, rev === '1')
                    setConnect(null)
                    void refetch()
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <button
              className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-subtle hover:bg-surface-hover"
              onClick={() => setConnect(null)}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
        {view === 'map' && until !== null && span && (
          <div
            className="paper absolute bottom-4 left-1/2 flex w-[min(520px,50%)] -translate-x-1/2 items-center gap-3 rounded-xl px-3.5 py-2.5 shadow-[var(--shadow-2)]"
            data-testid="graph-timeline"
          >
            <button
              aria-label={playing ? t('graph.pause') : t('graph.play')}
              onClick={() => setPlaying(!playing)}
              className="text-muted hover:text-fg"
            >
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </button>
            <input
              type="range"
              min={span.min}
              max={span.max}
              value={until}
              aria-label={t('graph.timeline')}
              onChange={(e) => {
                setPlaying(false)
                setUntil(Number(e.target.value))
              }}
              className="flex-1 accent-accent"
            />
            <span className="w-24 text-right text-2xs text-muted tabular-nums">{new Date(until).toLocaleDateString()}</span>
            <button aria-label={t('graph.clear')} onClick={() => setUntil(null)} className="text-subtle hover:text-fg">
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {discover && !selectedNode && g && (
          <DiscoverPanel
            graph={g}
            c={c}
            catColor={catColor}
            onSelect={goTo}
            onClose={() => setDiscover(false)}
            onChanged={() => void refetch()}
          />
        )}
        {selectedNode && g && (
          <NodePanel
            node={selectedNode}
            graph={g}
            edges={g.edges}
            c={c}
            catColor={catColor}
            hub={hubSet.has(selectedNode.key)}
            onOpen={() => openNode(selectedNode.key)}
            onFocus={() => useApp.getState().setGraphFocus(selectedNode.key)}
            onSelect={goTo}
            onClose={() => setSelected(null)}
            onChanged={() => void refetch()}
          />
        )}
      </div>
    </FloatingPanel>
  )
}
