// PDF 页面分流：判断哪些页需要“看图识别”。
// - scan：几乎没有文字层，但铺满了图片（扫描件、拍照转 PDF）→ 整页转写
// - table：有表格标题或大量格线 → 文字层会把单元格拆散，需要按表格还原
// - figure：有图标题、插图或大量矢量图形 → 文字层只剩零散的标签，需要说明结构
// 其余页面的文字层已经足够，不做识别（省时间、省钱）。

import { multiply, PageImageCoverage, transformedBox, type Matrix, type Polygon } from './pdfCoverage'

export type PageNeed = 'scan' | 'table' | 'figure'

export interface PageSignals {
  /** 文字层字符数（去掉空白） */
  chars: number
  /** 图片覆盖页面面积的比例（0–1，重叠区域只计一次） */
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
  paintImageMaskXObject: 83,
  paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89,
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
export function drawingSignals(
  fnArray: number[],
  argsArray: unknown[][],
  pageArea: number,
  bounds?: number[]
): { imageCover: number; paths: number } {
  const identity: Matrix = [1, 0, 0, 1, 0, 0]
  let state: { ctm: Matrix; clips: Polygon[] } = { ctm: identity, clips: bounds ? [transformedBox(bounds, identity)] : [] }
  const stack: (typeof state)[] = []
  const image = new PageImageCoverage()
  let paths = 0
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i]
    if (fn === OPS.save) stack.push(state)
    else if (fn === OPS.restore) state = stack.pop() ?? state
    else if (fn === OPS.transform) state = { ...state, ctm: multiply(state.ctm, args as unknown as Matrix) }
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(state)
      const m = args?.[0] as Matrix | null | undefined
      const ctm = m?.length === 6 ? multiply(state.ctm, m) : state.ctm
      const box = args?.[1] as number[] | undefined
      state = { ctm, clips: box?.length === 4 ? [...state.clips, transformedBox(box, ctm)] : state.clips }
    } else if (fn === OPS.paintFormXObjectEnd) state = stack.pop() ?? state
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject)
      image.add(state.ctm, state.clips)
    else if (fn === OPS.paintImageMaskXObjectGroup || fn === OPS.paintInlineImageXObjectGroup) {
      const instances = (fn === OPS.paintImageMaskXObjectGroup ? args[0] : args[1]) as { transform: Matrix }[]
      for (const instance of instances) image.add(multiply(state.ctm, instance.transform), state.clips)
    } else if (fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObjectRepeat) {
      const mask = fn === OPS.paintImageMaskXObjectRepeat
      const positions = args[mask ? 5 : 3] as number[]
      for (let j = 0; j < positions.length; j += 2) {
        const m: Matrix = mask
          ? [args[1] as number, args[2] as number, args[3] as number, args[4] as number, positions[j], positions[j + 1]]
          : [args[1] as number, 0, 0, args[2] as number, positions[j], positions[j + 1]]
        image.add(multiply(state.ctm, m), state.clips)
      }
    } else if (PATH_PAINT.has(fn) || fn === OPS.constructPath) paths++
  }
  return { imageCover: image.fraction(pageArea), paths }
}
