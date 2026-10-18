import { useEffect, useRef, useState } from 'react'
import type { DiagramData } from '@shared/embeds/visuals'
import { useTokens, type Tokens } from './tokens'
import { useExpandedPresentation } from '@/components/ui/ExpandableSurface'
import { decorateDiagram, mermaidThemeVariables } from './mermaidTheme'
let mermaidSeq = 0
async function loadMermaid(c?: Tokens) {
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // 纯 SVG 文字（不用 foreignObject）：导出时可以转成图片
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: 'base',
    fontFamily: 'inherit',
    themeVariables: c ? mermaidThemeVariables(c) : { background: 'transparent', fontSize: '14px' }
  })
  return mermaid
}

/** 供主进程校验 AI 生成的 Mermaid（语法错误时把错误反馈给模型修正） */
export async function validateMermaid(code: string): Promise<string | null> {
  try {
    const m = await loadMermaid()
    await m.parse(code)
    return null
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 800) : String(e).slice(0, 800)
  }
}

export function DiagramBox({ data: d, onReadyChange }: { data: DiagramData; onReadyChange?(ready: boolean): void }) {
  const { expanded } = useExpandedPresentation()
  const code = d.code
  const originalSize = useRef<{ node: SVGSVGElement; width: string; maxWidth: string } | null>(null)
  const c = useTokens()
  const host = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setSvg(null)
    setError(null)
    let alive = true
    void (async () => {
      try {
        const m = await loadMermaid(c)
        const decorated = await decorateDiagram(code, m, c)
        // 补上的配色语句万一和模型写的冲突，退回原文渲染，保证图能出来
        const { svg } = await m.render(`mmd-${++mermaidSeq}`, decorated).catch(() => m.render(`mmd-${++mermaidSeq}`, code))
        if (alive) {
          setSvg(svg)
          setError(null)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [code, c])
  useEffect(() => {
    if (!svg || !host.current) return
    // Mermaid 严格清理后的 SVG 仍去除可执行节点/属性，不将模型字符串作为 HTML 注入。
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    for (const node of doc.querySelectorAll('script, foreignObject')) node.remove()
    for (const node of doc.querySelectorAll('*'))
      for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name) || (/^(?:href|xlink:href)$/i.test(attr.name) && !attr.value.startsWith('#')))
          node.removeAttribute(attr.name)
      }
    if (doc.documentElement.tagName.toLowerCase() === 'svg') host.current.replaceChildren(document.importNode(doc.documentElement, true))
  }, [svg])
  useEffect(() => {
    onReadyChange?.(!!svg && !error)
  }, [svg, error, onReadyChange])
  useEffect(() => {
    const node = host.current?.querySelector('svg')
    if (!node) return
    if (originalSize.current?.node !== node) originalSize.current = { node, width: node.style.width, maxWidth: node.style.maxWidth }
    const width = node.viewBox.baseVal.width
    if (expanded && Number.isFinite(width) && width > 0) {
      node.style.width = `${width}px`
      node.style.maxWidth = 'none'
    } else {
      node.style.width = originalSize.current.width
      node.style.maxWidth = originalSize.current.maxWidth
    }
  }, [expanded, svg])
  if (error)
    return (
      <div>
        <p className="px-4 py-3 text-xs text-danger">{error}</p>
        <pre className="mx-4 mb-3 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-2xs text-muted">{d.code}</pre>
      </div>
    )
  return (
    <div className="diagram-svg flex justify-center overflow-x-auto px-4 py-3">
      {/* Mermaid securityLevel=strict 已清理输出 */}
      {svg ? <div ref={host} /> : <div className="h-24 w-full animate-pulse rounded bg-sunken" />}
    </div>
  )
}
