import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Route } from 'lucide-react'
import type { GraphEdge, GraphNode } from '@shared/types'
import { cn } from '@/lib/utils'
import { mix, type Tokens } from '../visuals/tokens'
import { statusColor } from '../review/MasteryView'
import { learningPath } from './model'

// 学习路径（v0.14.3）：只看“前置”关系，先修在左、后学在右；按掌握度着色，
// 标出“可以学了”（前置都已牢固）与“卡点”（没掌握、又挡住后面不少内容）。参考 Math Academy 的知识地图。

const W = 176,
  H = 44,
  GAP_X = 72,
  GAP_Y = 18,
  PAD = 32

export function LearningPath({
  nodes,
  edges,
  c,
  selected,
  onSelect
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  c: Tokens
  selected: string | null
  onSelect(key: string): void
}) {
  const { t } = useTranslation()
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes])
  const path = useMemo(() => learningPath(nodes, edges), [nodes, edges])
  const pos = useMemo(() => {
    const p = new Map<string, { x: number; y: number }>()
    path.layers.forEach((layer, i) => layer.forEach((k, j) => p.set(k, { x: PAD + i * (W + GAP_X), y: PAD + 40 + j * (H + GAP_Y) })))
    return p
  }, [path])
  if (!path.layers.length)
    return (
      <div className="absolute inset-0 grid place-items-center px-8 text-center" data-testid="graph-path">
        <div className="max-w-md">
          <Route className="mx-auto mb-3 size-6 text-subtle" />
          <p className="text-sm text-muted">{t('graph.path.empty')}</p>
        </div>
      </div>
    )
  const width = PAD * 2 + path.layers.length * (W + GAP_X) - GAP_X
  const height = PAD * 2 + 40 + Math.max(...path.layers.map((l) => l.length)) * (H + GAP_Y)
  const near = selected ? new Set([selected, ...path.edges.filter(([a, b]) => a === selected || b === selected).flat()]) : null
  return (
    <div className="absolute inset-0 overflow-auto" data-testid="graph-path">
      <div className="sticky top-0 left-0 z-10 flex flex-wrap gap-2 px-8 pt-16 pb-2 text-xs">
        <span className="rounded-full bg-emph-soft px-2.5 py-1 text-emph" data-testid="graph-path-frontier">
          {t('graph.path.frontier', { n: path.frontier.size })}
        </span>
        {path.blockers.length > 0 && (
          <span className="rounded-full bg-viz-4/10 px-2.5 py-1 text-viz-4">{t('graph.path.blockers', { n: path.blockers.length })}</span>
        )}
        {path.cycle.size > 0 && (
          <span className="rounded-full bg-sunken px-2.5 py-1 text-muted">{t('graph.path.cycle', { n: path.cycle.size })}</span>
        )}
        <span className="px-1 py-1 text-subtle">{t('graph.path.hint')}</span>
      </div>
      <svg width={width} height={height} className="mx-8 block" role="img" aria-label={t('graph.view.path')}>
        <defs>
          <marker id="path-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={mix(c.fg, c.surface, 0.55)} />
          </marker>
        </defs>
        {path.layers.map((_, i) => (
          <text key={i} x={PAD + i * (W + GAP_X) + W / 2} y={PAD + 18} textAnchor="middle" fontSize="11" fill={c.subtle}>
            {t('graph.path.step', { n: i + 1 })}
          </text>
        ))}
        {path.edges.map(([a, b]) => {
          const p = pos.get(a),
            q = pos.get(b)
          if (!p || !q) return null
          const x1 = p.x + W,
            y1 = p.y + H / 2,
            x2 = q.x - 2,
            y2 = q.y + H / 2,
            mid = (x1 + x2) / 2
          const dim = near && !(near.has(a) && near.has(b))
          return (
            <path
              key={`${a}|${b}`}
              d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
              fill="none"
              stroke={mix(c.fg, c.surface, dim ? 0.15 : 0.55)}
              strokeWidth={dim ? 1 : 1.8}
              markerEnd="url(#path-arrow)"
            />
          )
        })}
        {[...pos].map(([k, p]) => {
          const n = byKey.get(k)
          if (!n) return null
          const frontier = path.frontier.has(k),
            blocker = path.blockers.find((b) => b.key === k),
            dim = near && !near.has(k)
          const color = statusColor(n.mastery ?? 'blank', c)
          return (
            <g
              key={k}
              transform={`translate(${p.x},${p.y})`}
              opacity={dim ? 0.35 : 1}
              className="cursor-pointer"
              onClick={() => onSelect(k)}
              data-path-node={n.title}
              data-frontier={frontier || undefined}
            >
              <rect
                width={W}
                height={H}
                rx={10}
                fill={c.surface}
                stroke={frontier ? c.emph : blocker ? c.viz[3] : selected === k ? c.fg : c.border}
                strokeWidth={frontier || blocker || selected === k ? 2 : 1}
              />
              <rect x={0} y={0} width={5} height={H} rx={2.5} fill={color} />
              <text x={16} y={blocker || frontier ? 19 : 27} fontSize="13" fontWeight={500} fill={c.fg}>
                {n.title.length > 11 ? `${n.title.slice(0, 10)}…` : n.title}
                <title>{n.title}</title>
              </text>
              {(frontier || blocker) && (
                <text x={16} y={35} fontSize="10.5" fill={frontier ? c.emph : c.viz[3]}>
                  {[frontier && t('graph.path.ready'), blocker && t('graph.path.blocking', { n: blocker.blocked })]
                    .filter(Boolean)
                    .join(' · ')}
                </text>
              )}
              {path.cycle.has(k) && (
                <text x={W - 10} y={27} textAnchor="end" fontSize="11" fill={c.subtle}>
                  ↻
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <p className={cn('px-8 pt-2 pb-28 text-2xs text-subtle')}>{t('graph.path.legend')}</p>
    </div>
  )
}
