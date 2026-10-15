// PDF 页面分流：判断哪些页需要“看图识别”。
// - scan：几乎没有文字层，但铺满了图片（扫描件、拍照转 PDF）→ 整页转写
// - table：有表格标题或大量格线 → 文字层会把单元格拆散，需要按表格还原
// - figure：有图标题、插图或大量矢量图形 → 文字层只剩零散的标签，需要说明结构
// 其余页面的文字层已经足够，不做识别（省时间、省钱）。

export type PageNeed = 'scan' | 'table' | 'figure'

export interface PageSignals {
  /** 文字层字符数（去掉空白） */
  chars: number
  /** 图片覆盖页面面积的比例（0–1，多张图累加，封顶 1） */
  imageCover: number
  /** 矢量绘图次数（填充 / 描边的路径） */
  paths: number
  /** 文字层中的行（按纵坐标分行） */
  lines: string[]
}

// 图 / 表标题：行首编号后紧跟分隔符再接标题，如“表2-1。 组织结构对项目的影响”“图 3-3：关注价值”“Figure 4. Results”。
// 排除正文引用（“图1-2展示了……”编号后直接接正文）、目录（点线引导符）和过长的行。
const NUM = String.raw`\d+(?:[-–.．]\d+)*`
const TABLE_CAPTION = new RegExp(String.raw`^\s*(?:表\s*${NUM}|Table\s+${NUM})\s*[。.．:：\s]\s*\S`)
const FIGURE_CAPTION = new RegExp(String.raw`^\s*(?:图\s*${NUM}|Fig(?:ure|\.)\s*${NUM})\s*[。.．:：\s]\s*\S`)
// 标题长度上限：中文 40 字，西文 90 个字符（英文标题更长）
const captionMax = (l: string): number => (/[\u3400-\u9fff]/.test(l) ? 40 : 90)
const isCaptionLine = (l: string): boolean =>
  l.trim().length <= captionMax(l) && !/(\.\s?){4,}|…{2,}/.test(l) && !/展示|所示|说明了|比较了|列出了/.test(l)

export function classifyPageNeeds(s: PageSignals): PageNeed[] {
  if (s.chars < 30 && s.imageCover > 0.5) return ['scan']
  const captions = s.lines.filter(isCaptionLine)
  const needs: PageNeed[] = []
  if (captions.some((l) => TABLE_CAPTION.test(l))) needs.push('table')
  if (captions.some((l) => FIGURE_CAPTION.test(l))) needs.push('figure')
  // 没有标题但有明显的插图（照片、截图、图表）；铺满整页且文字很多的图片是背景装饰，不算
  if (!needs.includes('figure') && s.imageCover > 0.2 && (s.imageCover < 0.9 || s.chars < 200)) needs.push('figure')
  return needs
}

type Matrix = [number, number, number, number, number, number]
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
]

/** pdf.js 操作码（与 pdfjs-dist 的 OPS 一致） */
export const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
  constructPath: 91
} as const

const PATH_PAINT = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke
])

/** 从操作列表统计图片覆盖面积与矢量绘图次数（图片画在当前变换矩阵下的单位方块中） */
export function drawingSignals(fnArray: number[], argsArray: unknown[][], pageArea: number): { imageCover: number; paths: number } {
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = []
  let image = 0
  let paths = 0
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as Matrix)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      const m = args?.[0] as Matrix | null | undefined
      if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m)
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat)
      image += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])
    else if (PATH_PAINT.has(fn) || fn === OPS.constructPath) paths++
  }
  return { imageCover: pageArea > 0 ? Math.min(1, image / pageArea) : 0, paths }
}
