import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { MasteryMap, MasteryStatus, NoteMastery } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useTokens, type Tokens } from '@/features/visuals/tokens'

// 掌握度地图：分类 → 笔记的矩形树图（ECharts treemap）。面积 = 复习卡片数，颜色 = 掌握情况。
// 下方列表可以按“薄弱 / 空白 / 未开始 / 学习中 / 牢固”筛选，点击回到笔记。

export const STATUS_ORDER: MasteryStatus[] = ['weak', 'blank', 'new', 'learning', 'solid']

export function statusColor(s: MasteryStatus, c: Tokens): string {
  switch (s) {
    case 'weak':
      return c.danger
    case 'learning':
      return '#c8963e'
    case 'solid':
      return c.accent
    case 'new':
      // 浅一些的蓝灰：与“牢固”的主题色明显区分
      return '#8ba5ba'
    default:
      return c.border
  }
}

type TreeNode = {
  name: string
  value: number
  id?: string
  status?: MasteryStatus
  children?: TreeNode[]
  itemStyle?: { color: string }
  label?: { color: string }
}

function buildTree(map: MasteryMap, c: Tokens, uncategorized: string): TreeNode[] {
  const noteNode = (n: NoteMastery): TreeNode => ({
    name: n.title || '—',
    value: Math.max(1, n.cards),
    id: n.id,
    status: n.status,
    itemStyle: { color: statusColor(n.status, c) },
    // 空白块底色浅，文字用深色
    ...(n.status === 'blank' ? { label: { color: c.muted } } : {})
  })
  const kids = new Map<string | null, TreeNode[]>()
  const catNode = (id: string, name: string): TreeNode => {
    const children = [...(kids.get(id) ?? [])]
    return { name, value: children.reduce((s, x) => s + x.value, 0), children }
  }
  // 自底向上：先放笔记，再按层级把分类挂到父分类下
  for (const n of map.notes) kids.set(n.categoryId, [...(kids.get(n.categoryId) ?? []), noteNode(n)])
  const depth = (id: string): number => {
    let d = 0
    let p = map.categories.find((x) => x.id === id)?.parentId
    while (p) {
      d++
      p = map.categories.find((x) => x.id === p)?.parentId
    }
    return d
  }
  const cats = [...map.categories].sort((a, b) => depth(b.id) - depth(a.id))
  for (const cat of cats) {
    const node = catNode(cat.id, cat.name)
    if (node.value > 0) kids.set(cat.parentId, [...(kids.get(cat.parentId) ?? []), node])
  }
  const roots = kids.get(null) ?? []
  // 未分类的笔记单独成组
  const loose = roots.filter((r) => r.id)
  const groups = roots.filter((r) => !r.id)
  if (loose.length) groups.push({ name: uncategorized, value: loose.reduce((s, x) => s + x.value, 0), children: loose })
  return groups
}

function Treemap({ map }: { map: MasteryMap }) {
  const { t } = useTranslation()
  const c = useTokens()
  const el = useRef<HTMLDivElement>(null)
  const data = useMemo(() => buildTree(map, c, t('mastery.uncategorized')), [map, c, t])
  useEffect(() => {
    if (!el.current) return
    let disposed = false
    let chart: import('echarts').ECharts | null = null
    const ro = new ResizeObserver(() => chart?.resize())
    void import('echarts').then((echarts) => {
      if (disposed || !el.current) return
      const ch = echarts.init(el.current, undefined, { renderer: 'svg' })
      chart = ch
      ch.setOption({
        tooltip: {
          backgroundColor: c.surface,
          borderColor: c.border,
          textStyle: { color: c.fg, fontSize: 12 },
          formatter: (p: { data: TreeNode }) => {
            const n = map.notes.find((x) => x.id === p.data.id)
            if (!n) return `${p.data.name}`
            const recall = n.recall === null ? '—' : `${Math.round(n.recall * 100)}%`
            return `<b>${n.title || '—'}</b><br/>${t(`mastery.status.${n.status}`)} · ${t('mastery.cardsN', { count: n.cards })} · ${t('mastery.recall')} ${recall}`
          }
        },
        series: [
          {
            type: 'treemap',
            data,
            roam: false,
            nodeClick: false,
            breadcrumb: { show: false },
            width: '100%',
            height: '100%',
            top: 0,
            left: 0,
            label: { show: true, color: '#fff', fontSize: 12, overflow: 'truncate', formatter: '{b}' },
            upperLabel: { show: true, height: 22, color: c.muted, fontSize: 11, backgroundColor: 'transparent' },
            itemStyle: { borderColor: c.surface, borderWidth: 2, gapWidth: 2, borderRadius: 4 },
            levels: [
              { itemStyle: { borderColor: c.sunken, borderWidth: 4, gapWidth: 4, color: c.sunken }, upperLabel: { show: true } },
              { itemStyle: { borderColor: c.sunken, borderWidth: 2, gapWidth: 2 } }
            ]
          }
        ]
      })
      ch.on('click', (p) => {
        const id = (p.data as TreeNode | undefined)?.id
        if (id) useApp.getState().openNote(id)
      })
      ro.observe(el.current)
    })
    return () => {
      disposed = true
      ro.disconnect()
      chart?.dispose()
    }
  }, [data, map, c, t])
  return <div ref={el} className="mastery-map h-[360px] w-full" data-testid="mastery-map" />
}

export function MasteryPanel({ goalId }: { goalId?: string | null }) {
  const { t } = useTranslation()
  const c = useTokens()
  const { data: map } = useQuery({ queryKey: ['mastery', goalId ?? null], queryFn: () => api.mastery.map(goalId ?? null) })
  const [filter, setFilter] = useState<MasteryStatus | 'all'>('all')
  if (!map) return null
  if (!map.notes.length) return <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs text-muted">{t('mastery.empty')}</p>
  const list = map.notes
    .filter((n) => filter === 'all' || n.status === filter)
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (a.recall ?? 2) - (b.recall ?? 2))
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {(['all', ...STATUS_ORDER] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
              filter === s ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg'
            )}
          >
            {s !== 'all' && <span className="size-2 rounded-full" style={{ background: statusColor(s, c) }} />}
            {s === 'all' ? t('memory.kinds.all') : t(`mastery.status.${s}`)}
            <span className="opacity-60">{s === 'all' ? map.notes.length : map.totals[s]}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-surface p-2">
        <Treemap map={map} />
      </div>
      <p className="mt-2 text-2xs text-subtle">{t('mastery.legend')}</p>
      <ul className="mt-4 divide-y divide-border/60 rounded-2xl border border-border bg-surface">
        {list.map((n) => (
          <li key={n.id}>
            <button
              onClick={() => useApp.getState().openNote(n.id)}
              className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-hover"
              data-note={n.title}
            >
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: statusColor(n.status, c) }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{n.title || t('common.untitled')}</span>
                <span className="block text-2xs text-subtle">
                  {t(`mastery.hint.${n.status}`)}
                  {n.weakConcepts.length > 0 && ` · ${t('mastery.weakConcepts', { list: n.weakConcepts.join('、') })}`}
                </span>
              </span>
              <span className="shrink-0 text-right text-2xs text-muted tabular-nums">
                {n.cards > 0 && t('mastery.cardsN', { count: n.cards })}
                {n.recall !== null && (
                  <span className="ml-2">
                    {t('mastery.recall')} {Math.round(n.recall * 100)}%
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
