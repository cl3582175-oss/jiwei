import { z } from 'zod'

// 函数图与几何图（v0.9 可视化第 0 层补全，JSXGraph 渲染）。
// 数据是声明式模板：AI 只填参数，不写代码。表达式用自己的解析器编译，不 eval 任意代码。

/* ——— 表达式 ——— */

const FUNCTIONS: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  sign: Math.sign
}
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }
// 只认自有属性：普通对象的 in 会沿原型链命中 constructor、toString 等
const isFn = (name: string): boolean => Object.hasOwn(FUNCTIONS, name)
const isConst = (name: string): boolean => Object.hasOwn(CONSTANTS, name)

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'call'; fn: string; a: Node }

type Token = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const s = src.replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/π/g, 'pi').replace(/\*\*/g, '^').replace(/−/g, '-')
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i))
    if (num) {
      out.push({ k: 'num', v: Number(num[0]) })
      i += num[0].length
      continue
    }
    const id = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i))
    if (id) {
      out.push({ k: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    if ('+-*/^(),'.includes(c)) {
      out.push({ k: 'op', v: c })
      i++
      continue
    }
    throw new Error(`不支持的字符“${c}”`)
  }
  // 隐式乘法：2x、2(x+1)、(x+1)(x-1)、x sin(x)
  const res: Token[] = []
  for (const tk of out) {
    const prev = res[res.length - 1]
    const prevEnds = prev && (prev.k === 'num' || (prev.k === 'id' && !isFn(prev.v)) || (prev.k === 'op' && prev.v === ')'))
    const startsValue = tk.k === 'num' || tk.k === 'id' || (tk.k === 'op' && tk.v === '(')
    if (prevEnds && startsValue) res.push({ k: 'op', v: '*' })
    res.push(tk)
  }
  return res
}

/** 解析为语法树；vars 为允许出现的变量名（x 与参数名） */
export function parseExpression(src: string, vars: string[]): Node {
  if (src.length > 300) throw new Error('表达式过长')
  const toks = tokenize(src)
  let p = 0
  const peek = (): Token | undefined => toks[p]
  const isOp = (v: string): boolean => peek()?.k === 'op' && peek()!.v === v
  const expect = (v: string): void => {
    if (!isOp(v)) throw new Error(`缺少“${v}”`)
    p++
  }
  const expr = (): Node => {
    let a = term()
    while (isOp('+') || isOp('-')) {
      const op = (toks[p++] as { v: '+' | '-' }).v
      a = { t: 'bin', op, a, b: term() }
    }
    return a
  }
  const term = (): Node => {
    let a = unary()
    while (isOp('*') || isOp('/')) {
      const op = (toks[p++] as { v: '*' | '/' }).v
      a = { t: 'bin', op, a, b: unary() }
    }
    return a
  }
  const unary = (): Node => {
    if (isOp('-')) {
      p++
      return { t: 'neg', a: unary() }
    }
    if (isOp('+')) {
      p++
      return unary()
    }
    return power()
  }
  // 乘方右结合，且优先于一元负号：-x^2 = -(x^2)
  const power = (): Node => {
    const base = atom()
    if (isOp('^')) {
      p++
      return { t: 'bin', op: '^', a: base, b: unary() }
    }
    return base
  }
  const atom = (): Node => {
    const tk = peek()
    if (!tk) throw new Error('表达式不完整')
    if (tk.k === 'num') {
      p++
      return { t: 'num', v: tk.v }
    }
    if (tk.k === 'op' && tk.v === '(') {
      p++
      const a = expr()
      expect(')')
      return a
    }
    if (tk.k === 'id') {
      p++
      const name = tk.v
      if (isFn(name)) {
        expect('(')
        const a = expr()
        expect(')')
        return { t: 'call', fn: name, a }
      }
      if (isConst(name)) return { t: 'num', v: CONSTANTS[name] }
      if (vars.includes(name)) return { t: 'var', name }
      throw new Error(`未知的名称“${name}”`)
    }
    throw new Error(`意外的“${tk.v}”`)
  }
  const tree = expr()
  if (p < toks.length) throw new Error(`多余的“${(toks[p] as { v: string | number }).v}”`)
  return tree
}

function evaluate(n: Node, env: Record<string, number>): number {
  switch (n.t) {
    case 'num':
      return n.v
    case 'var':
      return env[n.name] ?? NaN
    case 'neg':
      return -evaluate(n.a, env)
    case 'call':
      return FUNCTIONS[n.fn](evaluate(n.a, env))
    case 'bin': {
      const a = evaluate(n.a, env),
        b = evaluate(n.b, env)
      return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : Math.pow(a, b)
    }
  }
}

/** 编译为求值函数（解析失败抛出带中文说明的错误） */
export function compileExpression(src: string, vars: string[]): (env: Record<string, number>) => number {
  const tree = parseExpression(src, vars)
  return (env) => evaluate(tree, env)
}

/* ——— 数据 ——— */

const color = z.enum(['bamboo', 'sky', 'lotus', 'apricot', 'sakura', 'gosling', 'moon']).optional()
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,15}$/)
const label = z.string().max(40).optional()

const FunctionGraph = z.object({
  type: z.literal('function'),
  functions: z
    .array(z.object({ expr: z.string().min(1).max(300), label, color }))
    .min(1)
    .max(6),
  params: z
    .array(
      z.object({
        name: z.string().regex(/^[a-wyzA-Z]$/),
        min: z.number(),
        max: z.number(),
        value: z.number(),
        step: z.number().positive().optional()
      })
    )
    .max(4)
    .default([]),
  /** 视窗 [xmin, xmax, ymin, ymax] */
  view: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([-6, 6, -4, 4])
})

const GeoElement = z.discriminatedUnion('type', [
  z.object({ type: z.literal('point'), id, x: z.number(), y: z.number(), fixed: z.boolean().optional(), label, color }),
  z.object({ type: z.literal('midpoint'), id, of: z.tuple([id, id]), label, color }),
  z.object({ type: z.literal('segment'), id, from: id, to: id, label, color }),
  z.object({ type: z.literal('line'), id, from: id, to: id, label, color }),
  z.object({ type: z.literal('circle'), id, center: id, through: id.optional(), radius: z.number().positive().optional(), label, color }),
  z.object({ type: z.literal('polygon'), id, points: z.array(id).min(3).max(12), label, color }),
  z.object({ type: z.literal('angle'), id, points: z.tuple([id, id, id]), label, color }),
  z.object({ type: z.literal('perpendicular'), id, line: id, through: id, label, color }),
  z.object({ type: z.literal('parallel'), id, line: id, through: id, label, color })
])

const GeometryGraph = z.object({
  type: z.literal('geometry'),
  elements: z.array(GeoElement).min(1).max(40),
  view: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([-6, 6, -4, 4]),
  axes: z.boolean().default(false)
})

export const GraphDataSchema = z.object({
  title: z.string().max(120).optional(),
  note: z.string().max(600).optional(),
  graph: z.discriminatedUnion('type', [FunctionGraph, GeometryGraph])
})
export type GraphData = z.infer<typeof GraphDataSchema>
export type GeoElementData = z.infer<typeof GeoElement>

const POINTS = new Set(['point', 'midpoint'])
const LINES = new Set(['segment', 'line', 'perpendicular', 'parallel'])

/** 语义校验（引用存在且类型正确、表达式可解析、视窗合理）；返回中文错误或 null */
export function checkGraph(d: GraphData): string | null {
  const g = d.graph
  const [x0, x1, y0, y1] = g.view
  if (!(x1 > x0 && y1 > y0)) return '视窗范围不合法：需要 xmin < xmax、ymin < ymax'
  if (g.type === 'function') {
    const names = new Set<string>()
    for (const p of g.params) {
      if (names.has(p.name)) return `参数 ${p.name} 重复`
      names.add(p.name)
      if (!(p.min < p.max) || p.value < p.min || p.value > p.max) return `参数 ${p.name} 的范围或取值不合法`
    }
    for (const f of g.functions) {
      try {
        compileExpression(f.expr, ['x', ...names])
      } catch (e) {
        return `函数“${f.expr}”无法解析：${e instanceof Error ? e.message : String(e)}`
      }
    }
    return null
  }
  const kinds = new Map<string, string>()
  for (const el of g.elements) {
    if (kinds.has(el.id)) return `元素 id“${el.id}”重复`
    const need = (ref: string, set: Set<string>, what: string): string | null =>
      !kinds.has(ref)
        ? `“${el.id}”引用了尚未定义的“${ref}”（元素需按依赖顺序给出）`
        : !set.has(kinds.get(ref)!)
          ? `“${el.id}”需要${what}，但“${ref}”不是`
          : null
    const errors: (string | null)[] =
      el.type === 'midpoint'
        ? el.of.map((r) => need(r, POINTS, '点'))
        : el.type === 'segment' || el.type === 'line'
          ? [need(el.from, POINTS, '点'), need(el.to, POINTS, '点')]
          : el.type === 'circle'
            ? [
                need(el.center, POINTS, '点'),
                el.through ? need(el.through, POINTS, '点') : el.radius ? null : `圆“${el.id}”需要 through 或 radius`
              ]
            : el.type === 'polygon' || el.type === 'angle'
              ? el.points.map((r) => need(r, POINTS, '点'))
              : el.type === 'perpendicular' || el.type === 'parallel'
                ? [need(el.line, LINES, '直线或线段'), need(el.through, POINTS, '点')]
                : []
    const err = errors.find(Boolean)
    if (err) return err
    kinds.set(el.id, el.type)
  }
  return null
}

/** 检索 / RAG 用的纯文本 */
export function graphText(d: GraphData): string {
  const g = d.graph
  const body =
    g.type === 'function'
      ? [
          ...g.functions.map((f) => `y = ${f.expr}${f.label ? `（${f.label}）` : ''}`),
          ...g.params.map((p) => `参数 ${p.name} ∈ [${p.min}, ${p.max}]`)
        ]
      : g.elements.map((el) => `${el.label ?? el.id}：${el.type}`)
  return [d.title ?? '', d.note ?? '', ...body].filter(Boolean).join('\n')
}
