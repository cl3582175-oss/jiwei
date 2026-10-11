import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, RotateCcw } from 'lucide-react'
import { GraphDataSchema, checkGraph, compileExpression, type GeoElementData, type GraphData } from '@shared/embeds/graph'
import { registerEmbedView, type EmbedViewProps } from './registry'
import { useTokens } from './VisualViews'

// 函数图与几何图（v0.9）：JSXGraph 渲染。函数图带参数滑块；几何图的自由点可以拖动，依赖它的元素随之更新。
// 配色取积微色板与当前主题；数据是声明式模板，表达式经 shared/embeds/graph 的解析器编译。

type Board = {
  update(): void
  create(type: string, parents: unknown[], attrs?: Record<string, unknown>): { Value?(): number; X?(): number; Y?(): number }
  removeObject?(o: unknown): void
}
type JXGModule = { JSXGraph: { initBoard(id: string, attrs: Record<string, unknown>): Board; freeBoard(b: Board): void } }

const TINT_INK: Record<string, string> = {
  bamboo: '--p-bamboo-ink',
  sky: '--p-sky-ink',
  lotus: '--p-lotus-ink',
  apricot: '--p-apricot-ink',
  sakura: '--p-sakura-ink',
  gosling: '--p-gosling-ink',
  moon: '--p-moon-ink'
}
const ORDER = ['sky', 'sakura', 'bamboo', 'apricot', 'lotus', 'moon']

/** 参数显示：整数不带小数，其余保留两位 */
const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, ''))

function useGraphData(entry: EmbedViewProps['entry']): GraphData | null {
  const json = JSON.stringify((entry.get('data') as { toJSON(): unknown } | undefined)?.toJSON?.() ?? null)
  return useMemo(() => {
    const r = GraphDataSchema.safeParse(JSON.parse(json))
    return r.success && !checkGraph(r.data) ? r.data : null
  }, [json])
}

function GraphView({ entry }: EmbedViewProps) {
  const { t } = useTranslation()
  const d = useGraphData(entry)
  const c = useTokens()
  const domId = `jxg-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const box = useRef<HTMLDivElement>(null)
  const [version, setVersion] = useState(0)
  const values = useRef<Record<string, number>>({})
  const boardRef = useRef<{ update(): void } | null>(null)
  const [shown, setShown] = useState<Record<string, number>>({})
  // 参数初值（数据变化或“恢复”时重置）
  useEffect(() => {
    if (d?.graph.type !== 'function') return
    const init = Object.fromEntries(d.graph.params.map((p) => [p.name, p.value]))
    values.current = { ...init }
    setShown(init)
  }, [d, version])
  useEffect(() => {
    if (!d || !box.current) return
    let disposed = false,
      board: Board | null = null,
      jxg: JXGModule | null = null
    const css = getComputedStyle(document.documentElement)
    const ink = (name: string | undefined, i: number): string =>
      css.getPropertyValue(TINT_INK[name ?? ORDER[i % ORDER.length]]).trim() || c.accent
    void import('jsxgraph').then((mod) => {
      if (disposed || !box.current) return
      jxg = ((mod as { default?: JXGModule }).default ?? mod) as JXGModule
      const [x0, x1, y0, y1] = d.graph.view
      const showAxes = d.graph.type === 'function' || d.graph.axes
      // 函数图四周留边：视窗贴着坐标轴时刻度数字不被裁掉
      const pad = d.graph.type === 'function' ? [(x1 - x0) * 0.06, (y1 - y0) * 0.08] : [0, 0]
      board = jxg.JSXGraph.initBoard(domId, {
        boundingbox: [x0 - pad[0], y1 + pad[1], x1 + pad[0], y0 - pad[1]],
        axis: false,
        showCopyright: false,
        showNavigation: false,
        pan: { enabled: false },
        zoom: { enabled: false },
        keepAspectRatio: d.graph.type === 'geometry'
      })
      const text = { strokeColor: c.fg, fontSize: 13, cssClass: 'jxg-label', highlightCssClass: 'jxg-label' }
      if (showAxes) {
        const axis = {
          strokeColor: c.subtle,
          highlightStrokeColor: c.subtle,
          ticks: { strokeColor: c.border, label: { strokeColor: c.muted, fontSize: 11 } }
        }
        board.create(
          'axis',
          [
            [0, 0],
            [1, 0]
          ],
          axis
        )
        board.create(
          'axis',
          [
            [0, 0],
            [0, 1]
          ],
          axis
        )
      }
      if (d.graph.type === 'function') {
        const g = d.graph
        // 参数滑块放在图下方（原生 range，可键盘操作），这里只读取当前值
        boardRef.current = board
        const vars = ['x', ...g.params.map((p) => p.name)]
        g.functions.forEach((fn, i) => {
          const run = compileExpression(fn.expr, vars)
          // 用参数曲线 (t, f(t)) 而不是 functiongraph：后者在 1.13 的 ESM 源码入口下 X(t) 未定义，曲线一个点也画不出
          board!.create(
            'curve',
            [
              (t: number) => t,
              (x: number) => {
                const env: Record<string, number> = { x, ...values.current }
                const y = run(env)
                return Number.isFinite(y) ? y : NaN
              },
              x0,
              x1
            ],
            {
              strokeColor: ink(fn.color, i),
              strokeWidth: 2.5,
              highlightStrokeWidth: 3,
              name: fn.label ?? '',
              withLabel: !!fn.label,
              label: text
            }
          )
        })
      } else {
        const made = new Map<string, unknown>()
        const ref = (id: string): unknown => made.get(id)
        // 几何图：主要元素统一一种颜色，辅助作图（垂线、平行线、角、中点）用第二种，颜色有含义而不是轮换
        const AUX = new Set(['perpendicular', 'parallel', 'angle', 'midpoint'])
        d.graph.elements.forEach((el: GeoElementData) => {
          const color = ink(el.color, AUX.has(el.type) ? 1 : 0)
          const base = { name: el.label ?? '', withLabel: !!el.label, label: text, strokeColor: color, highlightStrokeColor: color }
          const point = { ...base, fillColor: color, highlightFillColor: color, size: 3.5, name: el.label ?? el.id, withLabel: true }
          let o: unknown
          switch (el.type) {
            case 'point':
              o = board!.create('point', [el.x, el.y], { ...point, fixed: !!el.fixed, ...(el.fixed ? { size: 2.5 } : {}) })
              break
            case 'midpoint':
              o = board!.create('midpoint', el.of.map(ref), { ...point, size: 2.5 })
              break
            case 'segment':
              o = board!.create('segment', [ref(el.from), ref(el.to)], { ...base, strokeWidth: 2 })
              break
            case 'line':
              o = board!.create('line', [ref(el.from), ref(el.to)], { ...base, strokeWidth: 1.5 })
              break
            case 'circle':
              o = board!.create('circle', [ref(el.center), el.through ? ref(el.through) : el.radius], {
                ...base,
                strokeWidth: 2,
                fillOpacity: 0
              })
              break
            case 'polygon':
              o = board!.create('polygon', el.points.map(ref), {
                ...base,
                fillColor: color,
                fillOpacity: 0.08,
                highlightFillOpacity: 0.12,
                borders: { strokeColor: color, highlightStrokeColor: color, strokeWidth: 2 },
                vertices: { visible: false }
              })
              break
            case 'angle':
              o = board!.create('angle', el.points.map(ref), { ...base, fillColor: color, fillOpacity: 0.18, radius: 0.6 })
              break
            case 'perpendicular':
              o = board!.create('perpendicular', [ref(el.line), ref(el.through)], { ...base, dash: 2, strokeWidth: 1.5 })
              break
            case 'parallel':
              o = board!.create('parallel', [ref(el.line), ref(el.through)], { ...base, dash: 2, strokeWidth: 1.5 })
              break
          }
          made.set(el.id, o)
        })
      }
    })
    return () => {
      disposed = true
      if (board && jxg) jxg.JSXGraph.freeBoard(board)
    }
  }, [d, c, domId, version])
  if (!d)
    return (
      <div className="flex items-start gap-2 px-4 py-3 text-xs text-danger">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        {t('embeds.missing')}
      </div>
    )
  const draggable = d.graph.type === 'geometry' ? d.graph.elements.some((e) => e.type === 'point' && !e.fixed) : d.graph.params.length > 0
  return (
    <div data-testid="graph-embed">
      {d.title && <p className="px-4 pt-3 text-sm font-medium text-fg">{d.title}</p>}
      <div className="relative">
        <div id={domId} ref={box} className="jxgbox mx-auto aspect-[3/2] w-full max-w-[640px]" />
        {draggable && (
          <button
            className="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-surface-hover hover:text-fg"
            aria-label={t('embeds.graphReset')}
            title={t('embeds.graphReset')}
            onClick={() => setVersion((v) => v + 1)}
          >
            <RotateCcw className="size-3.5" />
          </button>
        )}
      </div>
      {d.graph.type === 'function' && d.graph.params.length > 0 && (
        <div className="grid gap-x-6 gap-y-2 px-4 pt-1 pb-2 sm:grid-cols-2" data-testid="graph-params">
          {d.graph.params.map((p) => (
            <label key={p.name} className="flex items-center gap-3 text-xs text-muted">
              <span className="w-16 shrink-0 font-serif text-sm text-fg tabular-nums">
                {p.name} = {fmt(shown[p.name] ?? p.value)}
              </span>
              <input
                type="range"
                aria-label={p.name}
                className="graph-range min-w-0 flex-1"
                min={p.min}
                max={p.max}
                step={p.step ?? (p.max - p.min) / 100}
                value={shown[p.name] ?? p.value}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  values.current = { ...values.current, [p.name]: v }
                  setShown((x) => ({ ...x, [p.name]: v }))
                  boardRef.current?.update()
                }}
              />
            </label>
          ))}
        </div>
      )}
      <p className="px-4 pb-3 text-2xs text-subtle">
        {d.note ? `${d.note} · ` : ''}
        {draggable ? t(d.graph.type === 'geometry' ? 'embeds.graphDragPoints' : 'embeds.graphDragSliders') : ''}
      </p>
    </div>
  )
}

registerEmbedView({ kind: 'graph', label: 'embeds.graph', View: GraphView })
