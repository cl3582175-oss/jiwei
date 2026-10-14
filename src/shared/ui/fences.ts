import { parseUiNode, uiFallbackMarkdown, uiToText } from './catalog'

export interface UiFenceData {
  index: number
  start: number
  end: number
  contentStart: number
  contentEnd: number
  openingEnd: number
  code: string
  closed: boolean
}
/** 同时追踪普通围栏，防止把代码样例中嵌套的 jiwei-ui 当成组件。 */
export function scanUiFences(md: string): UiFenceData[] {
  const out: UiFenceData[] = []
  let active: { char: string; length: number; ui?: Omit<UiFenceData, 'end' | 'contentEnd' | 'code' | 'closed'> } | null = null
  let offset = 0
  for (const line of md.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '')
    if (active) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(bare)
      if (close && close[1][0] === active.char && close[1].length >= active.length) {
        if (active.ui)
          out.push({
            ...active.ui,
            end: offset + line.length,
            contentEnd: offset,
            code: md.slice(active.ui.contentStart, offset),
            closed: true
          })
        active = null
      }
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^ \t\r\n]*)[^\r\n]*$/.exec(bare)
      if (open) {
        active = { char: open[1][0], length: open[1].length }
        if (open[2] === 'jiwei-ui')
          active.ui = { index: out.length, start: offset, contentStart: offset + line.length, openingEnd: offset + bare.length }
      }
    }
    offset += line.length
  }
  if (active?.ui) out.push({ ...active.ui, end: md.length, contentEnd: md.length, code: md.slice(active.ui.contentStart), closed: false })
  return out
}

/** 序号只取决于正文位置，React 严格模式重放和 memo 都不会改变身份。 */
export function annotateUiFences(md: string): string {
  const fences = scanUiFences(md)
  for (let i = fences.length - 1; i >= 0; i--) {
    const f = fences[i]
    // 丢弃模型元数据，避免冒充积微写入的内部身份。
    const line = md.slice(f.start, f.openingEnd).replace(/jiwei-ui.*$/, `jiwei-ui jiwei-index=${f.index} jiwei-open=${Number(!f.closed)}`)
    md = md.slice(0, f.start) + line + md.slice(f.openingEnd)
  }
  return md
}
/** 引用替换等正文转换不能碰任何语言的代码块。 */
export function mapOutsideFences(md: string, transform: (text: string) => string): string {
  let out = '',
    prose = '',
    active: { char: string; length: number } | null = null
  for (const line of md.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '')
    if (active) {
      out += line
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(bare)
      if (close && close[1][0] === active.char && close[1].length >= active.length) active = null
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/.exec(bare)
      if (open) {
        out += transform(prose) + line
        prose = ''
        active = { char: open[1][0], length: open[1].length }
      } else prose += line
    }
  }
  return out + transform(prose)
}
export function uiAnswerText(md: string): string {
  const fences = scanUiFences(md)
  for (let i = fences.length - 1; i >= 0; i--) {
    const f = fences[i]
    let text: string
    try {
      const value: unknown = JSON.parse(f.code),
        r = parseUiNode(value)
      text = r.ok ? uiToText(r.node) : uiFallbackMarkdown(value, f.code)
    } catch {
      text = f.code
    }
    md = md.slice(0, f.start) + text + '\n' + md.slice(f.end)
  }
  return md
}
