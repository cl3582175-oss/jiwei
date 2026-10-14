import { useEffect, useMemo, useState } from 'react'

type Key =
  | 'accent'
  | 'accentFg'
  | 'fg'
  | 'muted'
  | 'subtle'
  | 'border'
  | 'borderStrong'
  | 'surface'
  | 'sunken'
  | 'danger'
  | 'dark'
  | 'p1'
  | 'p2'
  | 'p3'
  | 'p4'
  | 'p5'
  | 'emph'
  | 'rest'
export type Tokens = Record<Key, string> & { viz: string[]; vizSoft: string[] }

const VIZ_FALLBACK = ['#2f6fb3', '#d9682b', '#1f9a8a', '#c94540', '#7a5cc2', '#b07d0a', '#d0527a', '#3d7f2a']

const hex = (v: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim())
  return m ? ([0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number]) : null
}
/** 两色按比例混合成实色。Mermaid、ECharts 只认实色，不能直接给 color-mix()。 */
export function mix(a: string, b: string, t: number): string {
  const x = hex(a),
    y = hex(b)
  if (!x || !y) return a
  return `#${x
    .map((v, i) =>
      Math.round(v * t + y[i] * (1 - t))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

/** 从页面读取当前主题的颜色（变量名与 globals.css 一致）。 */
export function readTokens(): Tokens {
  const css = getComputedStyle(document.documentElement)
  const g = (k: string, f: string): string => css.getPropertyValue(k).trim() || f
  const surface = g('--surface', '#fff')
  const dark = document.documentElement.dataset.theme === 'dark'
  const viz = VIZ_FALLBACK.map((f, i) => g(`--viz-${i + 1}`, f))
  const subtle = g('--fg-subtle', '#999')
  return {
    accent: g('--accent', '#3d8a74'),
    accentFg: g('--accent-fg', '#fff'),
    fg: g('--fg', '#222'),
    muted: g('--fg-muted', '#666'),
    subtle,
    border: g('--border', '#ddd'),
    borderStrong: g('--border-strong', '#ccc'),
    surface,
    sunken: g('--bg-sunken', '#f4f4f2'),
    danger: g('--danger', '#c0473a'),
    dark: dark ? '1' : '',
    p1: g('--p-bamboo-ink', '#3f6b52'),
    p2: g('--p-apricot-ink', '#8a5a22'),
    p3: g('--p-sakura-ink', '#9a4b47'),
    p4: g('--p-sky-ink', '#3e6680'),
    p5: g('--p-lotus-ink', '#7a4f74'),
    emph: viz[1],
    /** 非重点数据：退到背景里，但仍看得见 */
    rest: mix(subtle, surface, 0.55),
    viz,
    /** 分类色的浅底（示意图节点、分组底色） */
    vizSoft: viz.map((c) => mix(c, surface, dark ? 0.26 : 0.14))
  }
}

/** 主题或配色切换时重新读取 */
export function useTokens(): Tokens {
  const [v, setV] = useState(0)
  useEffect(() => {
    const obs = new MutationObserver(() => setV((x) => x + 1))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] })
    return () => obs.disconnect()
  }, [])
  return useMemo(() => readTokens(), [v]) // eslint-disable-line react-hooks/exhaustive-deps
}
