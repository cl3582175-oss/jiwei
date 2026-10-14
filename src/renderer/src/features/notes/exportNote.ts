import i18n from 'i18next'
import { toast } from 'sonner'
import { api } from '@/lib/utils'

// 导出前从编辑器中截取富内容块的图片：SVG（HTML / PDF 直接内嵌）+ PNG（Markdown 图片文件、Word）。
// 含 foreignObject 的 SVG（如导图的文字）无法转为位图，此时只提供 SVG，Word 中改用文字形式。

export interface EmbedImage {
  svg?: string
  png?: string
  width?: number
  height?: number
}

export const EMBED_SVG_SELECTOR = 'svg.mindmap-svg, .chart-canvas svg, .diagram-svg svg'

async function rasterize(svg: string, w: number, h: number): Promise<string | undefined> {
  if (svg.includes('<foreignObject')) return undefined
  try {
    const img = new Image()
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
    await img.decode()
    const k = 2
    const c = document.createElement('canvas')
    c.width = Math.round(w * k)
    c.height = Math.round(h * k)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  } catch {
    return undefined
  }
}

export async function collectEmbedImages(root: ParentNode = document): Promise<Record<string, EmbedImage>> {
  const out: Record<string, EmbedImage> = {}
  for (const el of root.querySelectorAll<HTMLElement>('.cornell-doc .embed-block[data-embed-id]')) {
    const id = el.dataset.embedId!
    const picture = await collectSvgImage(el)
    if (picture) out[id] = picture
  }
  return out
}

/** 回答组件与笔记导出共用实际 SVG，避免另起截图实现或新增依赖。 */
export async function collectSvgImage(root: ParentNode): Promise<EmbedImage | null> {
  const svgEl = root.querySelector<SVGSVGElement>(EMBED_SVG_SELECTOR)
  if (!svgEl) return null
  const box = svgEl.getBoundingClientRect()
  const w = Math.max(1, Math.round(box.width))
  const h = Math.max(1, Math.round(box.height))
  const clone = svgEl.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  // ECharts 等会给 SVG 加绝对定位，导出时还原为普通排版
  clone.style.removeProperty('position')
  clone.style.removeProperty('left')
  clone.style.removeProperty('top')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`)
  // 把界面配色变量写成具体颜色，脱离应用也能正确显示
  const css = getComputedStyle(document.documentElement)
  let svg = new XMLSerializer().serializeToString(clone)
  svg = svg.replace(/var\(--([a-z0-9-]+)(?:,[^)]*)?\)/gi, (m, name: string) => css.getPropertyValue(`--${name}`).trim() || m)
  return { svg, width: w, height: h, png: await rasterize(svg, w, h) }
}

export async function exportCurrentNote(noteId: string, format: 'md' | 'html' | 'pdf' | 'docx'): Promise<void> {
  try {
    const images = await collectEmbedImages()
    const file = await api.notes.export(noteId, format, images)
    if (file)
      toast.success(i18n.t('export.done'), {
        description: file,
        action: { label: i18n.t('export.show'), onClick: () => void api.app.showInFolder(file) }
      })
  } catch (e) {
    toast.error(String(e instanceof Error ? e.message : e))
  }
}
