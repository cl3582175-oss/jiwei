/** 扫描版面坐标统一为 0–1000；只投影有效文字，不把页眉页脚重复放进选区。 */
export interface ScanBlock {
  label: string
  box: [number, number, number, number]
  text: string
}
export interface ScanLine {
  text: string
  left: number
  top: number
  width: number
  height: number
  fontSize: number
  block: number
}
export function scanTextLayout(blocks: ScanBlock[], width: number, height: number): ScanLine[] {
  if (!(width > 0 && height > 0)) return []
  return blocks.flatMap((b, block) => {
    if (['header', 'footer', 'page_number', 'header_image', 'footer_image', 'image'].includes(b.label)) return []
    const [x0, y0, x1, y1] = b.box
    if (!b.box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000) || x1 <= x0 || y1 <= y0) return []
    const lines = b.text.split(/\r?\n/).filter((s) => s.trim())
    if (!lines.length) return []
    const w = ((x1 - x0) * width) / 1000
    const h = ((y1 - y0) * height) / 1000 / lines.length
    const longest = Math.max(...lines.map((s) => [...s].reduce((n, c) => n + (c.codePointAt(0)! > 255 ? 1 : 0.55), 0)))
    const fontSize = Math.max(6, Math.min(48, h * 0.85, w / Math.max(1, longest)))
    return lines.map((text, i) => ({
      text,
      block,
      left: (x0 * width) / 1000,
      top: (y0 * height) / 1000 + h * i,
      width: w,
      height: h,
      fontSize
    }))
  })
}
