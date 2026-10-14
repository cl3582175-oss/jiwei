// 非完整数组末项的身份独立于模型字段，模型无法伪造这个 Symbol。
export const PARTIAL = Symbol('__partial')
export type PartialObject = Record<string, unknown> & { [PARTIAL]?: true }
export interface PartialJson {
  value: unknown
  complete: boolean
}

/** 线性扫描恢复 JSON 前缀；不补出没收到的数字、布尔值或完整数组条目。 */
export function parsePartialJson(text: string): PartialJson {
  try {
    return { value: JSON.parse(text), complete: true }
  } catch {
    /* 继续解析前缀 */
  }
  if (text.length > 65_536) return { value: undefined, complete: false }
  let pos = 0
  type Read = { value?: unknown; closed: boolean; has: boolean }
  const space = (): void => {
    while (/\s/.test(text[pos] ?? '') && pos < text.length) pos++
  }
  const string = (): Read => {
    const start = pos++
    let end = pos
    while (pos < text.length) {
      if (text[pos] === '"') {
        pos++
        try {
          return { value: JSON.parse(text.slice(start, pos)), closed: true, has: true }
        } catch {
          return { closed: false, has: false }
        }
      }
      if (text[pos] === '\\') {
        if (pos + 1 >= text.length) break
        if (text[pos + 1] === 'u') {
          if (!/^[0-9a-f]{4}$/i.test(text.slice(pos + 2, pos + 6))) break
          pos += 6
        } else {
          if (!/["\\/bfnrt]/.test(text[pos + 1])) break
          pos += 2
        }
      } else {
        if (text.charCodeAt(pos) < 32) break
        pos++
      }
      end = pos
    }
    try {
      return { value: JSON.parse(text.slice(start, end) + '"'), closed: false, has: true }
    } catch {
      return { closed: false, has: false }
    }
  }
  const read = (depth: number): Read => {
    space()
    if (depth > 64 || pos >= text.length) return { closed: false, has: false }
    if (text[pos] === '"') return string()
    if (text[pos] === '{') {
      pos++
      const out: PartialObject = {}
      let closed = false
      space()
      if (text[pos] === '}') {
        pos++
        closed = true
      } else
        while (pos < text.length) {
          space()
          if (text[pos] !== '"') break
          const key = string()
          if (!key.closed) break
          space()
          if (text[pos++] !== ':') break
          const value = read(depth + 1)
          // defineProperty 避免 __proto__ 键改变对象原型。
          if (value.has)
            Object.defineProperty(out, key.value as string, { value: value.value, enumerable: true, configurable: true, writable: true })
          if (!value.closed) break
          space()
          if (text[pos] === '}') {
            pos++
            closed = true
            break
          }
          if (text[pos++] !== ',') break
        }
      if (!closed) Object.defineProperty(out, PARTIAL, { value: true })
      return { value: out, closed, has: true }
    }
    if (text[pos] === '[') {
      pos++
      const out: unknown[] = []
      let closed = false
      space()
      if (text[pos] === ']') {
        pos++
        closed = true
      } else
        while (pos < text.length) {
          const value = read(depth + 1)
          if (value.has && (value.closed || (typeof value.value === 'object' && value.value !== null && !Array.isArray(value.value))))
            out.push(value.value)
          if (!value.closed) break
          space()
          if (text[pos] === ']') {
            pos++
            closed = true
            break
          }
          if (text[pos++] !== ',') break
        }
      return { value: out, closed, has: true }
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos))
    if (!m) return { closed: false, has: false }
    const end = pos + m[0].length
    // 流式标量必须等到分隔符，2e 尚未结束时不能误画成 2。
    if (end === text.length || !/[\s,\]}]/.test(text[end])) return { closed: false, has: false }
    pos = end
    try {
      return { value: JSON.parse(m[0]), closed: true, has: true }
    } catch {
      return { closed: false, has: false }
    }
  }
  try {
    return { value: read(0).value, complete: false }
  } catch {
    return { value: undefined, complete: false }
  }
}
