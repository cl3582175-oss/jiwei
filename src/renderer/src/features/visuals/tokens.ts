import { useEffect, useMemo, useState } from 'react'
export function useTokens(): Record<string, string> {
  const [v, setV] = useState(0)
  useEffect(() => {
    const obs = new MutationObserver(() => setV((x) => x + 1))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] })
    return () => obs.disconnect()
  }, [])
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement)
    const g = (k: string, f: string): string => css.getPropertyValue(k).trim() || f
    return {
      accent: g('--accent', '#3d8a74'),
      fg: g('--fg', '#222'),
      muted: g('--muted', '#666'),
      subtle: g('--subtle', '#999'),
      border: g('--border', '#ddd'),
      surface: g('--surface', '#fff'),
      sunken: g('--sunken', '#f4f4f2'),
      danger: g('--danger', '#c0473a'),
      dark: document.documentElement.dataset.theme === 'dark' ? '1' : '',
      p1: g('--p-bamboo-ink', '#3f6b52'),
      p2: g('--p-apricot-ink', '#8a5a22'),
      p3: g('--p-sakura-ink', '#9a4b47'),
      p4: g('--p-sky-ink', '#3e6680'),
      p5: g('--p-lotus-ink', '#7a4f74')
    }
  }, [v]) // eslint-disable-line react-hooks/exhaustive-deps
}
