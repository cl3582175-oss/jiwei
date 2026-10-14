// 公式是数据：只构建白名单 AST，不把模型字符串交给 JavaScript 执行。
type Ast =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; value: Ast }
  | { kind: 'binary'; op: string; left: Ast; right: Ast }
  | { kind: 'call'; name: string; args: Ast[] }
  | { kind: 'conditional'; test: Ast; yes: Ast; no: Ast }
const functions: Record<string, { min: number; max: number; run: (...args: number[]) => number }> = {
  min: { min: 1, max: 20, run: Math.min },
  max: { min: 1, max: 20, run: Math.max },
  round: { min: 1, max: 2, run: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n },
  floor: { min: 1, max: 1, run: Math.floor },
  ceil: { min: 1, max: 1, run: Math.ceil },
  abs: { min: 1, max: 1, run: Math.abs },
  sqrt: { min: 1, max: 1, run: Math.sqrt },
  log: { min: 1, max: 1, run: Math.log },
  exp: { min: 1, max: 1, run: Math.exp },
  pow: { min: 2, max: 2, run: Math.pow },
  pmt: { min: 3, max: 3, run: (rate, nper, pv) => (rate === 0 ? pv / nper : (pv * rate) / (1 - (1 + rate) ** -nper)) }
}

export function compileExpr(
  src: string,
  vars: string[]
): { ok: true; run(values: Record<string, number>): number } | { ok: false; error: string } {
  try {
    if (src.length > 200) throw new Error('表达式过长')
    const tokens: string[] = []
    for (let offset = 0; offset < src.length;) {
      const m =
        /^\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z][A-Za-z0-9_]*)|(<=|>=|==|!=|[+*/^%(),<>?:-]))/.exec(
          src.slice(offset)
        )
      if (!m) {
        if (!src.slice(offset).trim()) break
        throw new Error('表达式含不允许的字符')
      }
      tokens.push(m[1] ?? m[2] ?? m[3])
      offset += m[0].length
    }
    let pos = 0,
      recursion = 0
    const take = (token: string): boolean => (tokens[pos] === token ? (++pos, true) : false)
    const require = (token: string): void => {
      if (!take(token)) throw new Error(`缺少 ${token}`)
    }
    const nested = (parse: () => Ast): Ast => {
      if (++recursion > 32) throw new Error('表达式嵌套过深')
      try {
        return parse()
      } finally {
        recursion--
      }
    }
    const atom = (): Ast =>
      nested(() => {
        if (take('(')) {
          const value = conditional()
          require(')')
          return value
        }
        const token = tokens[pos++]
        if (!token) throw new Error('缺少表达式')
        if (/^(?:\d|\.)/.test(token)) return { kind: 'number', value: Number(token) }
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) throw new Error('无效变量')
        if (take('(')) {
          const fn = Object.hasOwn(functions, token) ? functions[token] : undefined
          if (!fn) throw new Error('未知函数')
          const args: Ast[] = []
          if (!take(')')) {
            do {
              args.push(conditional())
            } while (take(','))
            require(')')
          }
          if (args.length < fn.min || args.length > fn.max) throw new Error('函数参数个数错误')
          return { kind: 'call', name: token, args }
        }
        if (!vars.includes(token)) throw new Error('未知变量')
        return { kind: 'variable', name: token }
      })
    const unary = (): Ast => (take('-') ? nested(() => ({ kind: 'unary', value: unary() })) : atom())
    const power = (): Ast => {
      const left = unary()
      return take('^') ? nested(() => ({ kind: 'binary', op: '^', left, right: power() })) : left
    }
    const binary = (next: () => Ast, ops: string[]): Ast => {
      let left = next()
      while (ops.includes(tokens[pos])) {
        const op = tokens[pos++]
        left = { kind: 'binary', op, left, right: next() }
      }
      return left
    }
    const product = (): Ast => binary(power, ['*', '/', '%'])
    const sum = (): Ast => binary(product, ['+', '-'])
    const comparison = (): Ast => binary(sum, ['<', '<=', '>', '>=', '==', '!='])
    const conditional = (): Ast => {
      const test = comparison()
      if (!take('?')) return test
      return nested(() => {
        const yes = conditional()
        require(':')
        return { kind: 'conditional', test, yes, no: conditional() }
      })
    }
    const ast = conditional()
    if (pos !== tokens.length) throw new Error('表达式未结束')
    const depth = (a: Ast): number => {
      switch (a.kind) {
        case 'number':
        case 'variable':
          return 1
        case 'unary':
          return 1 + depth(a.value)
        case 'binary':
          return 1 + Math.max(depth(a.left), depth(a.right))
        case 'conditional':
          return 1 + Math.max(depth(a.test), depth(a.yes), depth(a.no))
        case 'call':
          return 1 + Math.max(...a.args.map(depth))
      }
    }
    if (depth(ast) > 32) throw new Error('表达式嵌套过深')
    const calculate = (a: Ast, values: Record<string, number>): number => {
      switch (a.kind) {
        case 'number':
          return a.value
        case 'variable':
          return Object.hasOwn(values, a.name) ? values[a.name] : NaN
        case 'unary':
          return -calculate(a.value, values)
        case 'call':
          return functions[a.name].run(...a.args.map((arg) => calculate(arg, values)))
        case 'conditional':
          return calculate(a.test, values) ? calculate(a.yes, values) : calculate(a.no, values)
        case 'binary': {
          const l = calculate(a.left, values),
            r = calculate(a.right, values)
          switch (a.op) {
            case '+':
              return l + r
            case '-':
              return l - r
            case '*':
              return l * r
            case '/':
              return l / r
            case '%':
              return l % r
            case '^':
              return l ** r
            case '<':
              return Number(l < r)
            case '<=':
              return Number(l <= r)
            case '>':
              return Number(l > r)
            case '>=':
              return Number(l >= r)
            case '==':
              return Number(l === r)
            case '!=':
              return Number(l !== r)
          }
        }
      }
      return NaN
    }
    return { ok: true, run: (values) => calculate(ast, values) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '公式有误' }
  }
}
