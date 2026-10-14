import { z } from 'zod'
import {
  ChartDataSchema,
  checkChart,
  chartText,
  DiagramDataSchema,
  TimelineDataSchema,
  timelineText,
  StepsDataSchema,
  checkSteps,
  stepsText,
  type ChartData
} from '../embeds/visuals'
import { compileExpr } from './expr'
import { PARTIAL } from './partialJson'

export const UI_LIMITS = { bytes: 65_536, depth: 4, nodes: 60, tableRows: 50, tableCols: 8, perAnswer: { normal: 3, rich: 6 } } as const
const s = (n: number) => z.string().max(n)
const ref = s(80).min(1)
const cite = z.array(z.number().int().min(1).max(99)).max(8).optional()
const Base = {
  id: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
  title: s(120).optional(),
  note: s(300).optional(),
  cite
}
const scalar = z.union([s(2000), z.number(), z.null()])
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`)
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v
  }, '日期无效')
const time = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .refine((v) => date.safeParse(v.slice(0, 10)).success && Number(v.slice(11, 13)) < 24 && Number(v.slice(14)) < 60, '时间无效')
const Field = z.object({
  key: s(30).min(1),
  label: s(30),
  kind: z.enum(['text', 'number', 'select', 'date', 'slider', 'toggle']),
  required: z.boolean().optional(),
  placeholder: s(40).optional(),
  options: z
    .array(z.object({ label: s(40), value: s(60) }))
    .max(12)
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  value: z.union([s(2000), z.number(), z.boolean()]).optional()
})
const LeafSchema = z.discriminatedUnion('type', [
  z.object({
    ...Base,
    type: z.literal('stat'),
    items: z
      .array(
        z.object({
          label: s(30),
          value: z.union([s(200), z.number()]),
          unit: s(10).optional(),
          delta: s(20).optional(),
          trend: z.enum(['up', 'down', 'flat']).optional(),
          note: s(60).optional()
        })
      )
      .min(1)
      .max(6)
  }),
  z.object({
    ...Base,
    type: z.literal('table'),
    columns: z
      .array(
        z.object({
          key: s(30).min(1),
          label: s(30),
          kind: z.enum(['text', 'number', 'date', 'tag']).optional(),
          align: z.enum(['left', 'right']).optional()
        })
      )
      .min(1)
      .max(8),
    rows: z.array(z.record(z.string(), scalar)).max(50),
    highlight: z
      .array(z.object({ row: z.number().int().nonnegative().optional(), col: s(30).optional() }))
      .max(10)
      .optional(),
    editable: z.boolean().optional()
  }),
  z.object({
    ...Base,
    type: z.literal('list'),
    items: z
      .array(z.object({ text: s(200), done: z.boolean().optional(), note: s(120).optional(), cite }))
      .min(1)
      .max(30),
    checkable: z.boolean().optional(),
    ordered: z.boolean().optional()
  }),
  z.object({
    ...Base,
    type: z.literal('steps'),
    items: z
      .array(z.object({ title: s(60), detail: s(400).optional() }))
      .min(2)
      .max(12),
    current: z.number().int().nonnegative().optional()
  }),
  ChartDataSchema.omit({ type: true, anchor: true }).extend({ ...Base, type: z.literal('chart'), kind: ChartDataSchema.shape.type }),
  z.object({ ...Base, type: z.literal('diagram'), code: DiagramDataSchema.shape.code, diagramTitle: s(120).optional() }),
  TimelineDataSchema.extend({
    ...Base,
    type: z.literal('timeline'),
    events: z
      .array(TimelineDataSchema.shape.events.element.omit({ anchor: true }))
      .min(2)
      .max(60)
  }),
  StepsDataSchema.extend({ ...Base, type: z.literal('codesteps') }),
  z.object({
    ...Base,
    type: z.literal('choice'),
    question: s(200),
    options: z
      .array(z.object({ label: s(40), value: s(60), hint: s(80).optional() }))
      .min(2)
      .max(10),
    multi: z.boolean().optional()
  }),
  z.object({ ...Base, type: z.literal('form'), fields: z.array(Field).min(1).max(10), submitLabel: s(12).optional() }),
  z.object({
    ...Base,
    type: z.literal('calc'),
    inputs: z
      .array(
        z.object({
          // 模型常写 sciW、H 这类变量名：允许大写，长度放宽到 24
          key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,23}$/),
          label: s(30),
          kind: z.enum(['slider', 'number']),
          min: z.number(),
          max: z.number(),
          step: z.number(),
          value: z.number(),
          unit: s(10).optional()
        })
      )
      .min(1)
      .max(6),
    outputs: z
      .array(
        z.object({
          label: s(30),
          expr: s(200),
          unit: s(10).optional(),
          format: z.enum(['0', '0.0', '0.00', '0,0', '0%', '0.0%']).optional()
        })
      )
      .min(1)
      .max(4)
  }),
  z.object({
    ...Base,
    type: z.literal('quiz'),
    items: z
      .array(
        z.object({
          q: s(300),
          options: z.array(s(120)).min(2).max(6).optional(),
          answer: z.union([s(600), z.number()]),
          explain: s(600),
          cite
        })
      )
      .min(1)
      .max(10)
  }),
  z.object({
    ...Base,
    type: z.literal('flashcards'),
    cards: z
      .array(z.object({ front: s(200), back: s(600), cite }))
      .min(1)
      .max(20)
  }),
  z.object({ ...Base, type: z.literal('cloze'), text: s(1000), explain: s(400).optional() }),
  z.object({
    ...Base,
    type: z.literal('schedule'),
    range: z.object({ from: date, to: date }),
    proposals: z
      .array(z.object({ title: s(60), start: time, end: time, goalId: ref.optional() }))
      .max(20)
      .optional()
  }),
  z.object({
    ...Base,
    type: z.literal('tasks'),
    filter: z.object({ scope: z.enum(['today', 'open', 'goal', 'note']), goalId: ref.optional(), noteId: ref.optional() }).optional(),
    drafts: z
      .array(z.object({ title: s(120), due: date.optional() }))
      .max(20)
      .optional()
  }),
  z.object({ ...Base, type: z.literal('note'), noteId: ref, rowIds: z.array(ref).max(5).optional() }),
  z.object({ ...Base, type: z.literal('excerpt'), cite: z.number().int().min(1).max(99).optional(), segmentId: ref.optional() }),
  z.object({ ...Base, type: z.literal('mastery'), scope: z.object({ kind: z.enum(['all', 'goal', 'note']), id: ref.optional() }) }),
  z.object({
    ...Base,
    type: z.literal('decision'),
    decisionId: ref.optional(),
    question: s(200).optional(),
    options: z
      .array(z.object({ id: ref, title: s(40) }))
      .min(2)
      .max(5)
      .optional(),
    criteria: z
      .array(z.object({ name: s(30), weight: z.number().min(1).max(5) }))
      .min(2)
      .max(8)
      .optional(),
    scores: z
      .array(z.object({ option: ref, criterion: s(30), score: z.number().min(1).max(5) }))
      .max(40)
      .optional()
  }),
  z.object({ ...Base, type: z.literal('usage'), range: z.enum(['today', 'month']) })
])
type Common = z.infer<z.ZodObject<typeof Base>>
export type UiNode =
  | z.infer<typeof LeafSchema>
  | (Common & { type: 'columns'; ratio?: '1:1' | '382:618' | '618:382' | '1:1:1'; children: UiNode[] })
  | (Common & { type: 'tabs'; tabs: { label: string; children: UiNode[] }[] })
  | (Common & { type: 'details'; summary: string; children: UiNode[]; open?: boolean })
export type UiType = UiNode['type']
const TreeSchema: z.ZodType<UiNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    ...LeafSchema.options,
    z.object({
      ...Base,
      type: z.literal('columns'),
      ratio: z.enum(['1:1', '382:618', '618:382', '1:1:1']).optional(),
      children: z.array(TreeSchema).min(2).max(3)
    }),
    z.object({
      ...Base,
      type: z.literal('tabs'),
      tabs: z
        .array(z.object({ label: s(20), children: z.array(TreeSchema).min(1).max(3) }))
        .min(2)
        .max(5)
    }),
    z.object({
      ...Base,
      type: z.literal('details'),
      summary: s(80),
      children: z.array(TreeSchema).min(1).max(3),
      open: z.boolean().optional()
    })
  ])
)

export const UI_TYPES: {
  type: UiType
  group: 'layout' | 'basic' | 'data' | 'practice' | 'tool'
  tiers: ('basic' | 'strong')[]
  minDensity: 'normal' | 'rich'
}[] = [
  ...(['columns', 'tabs', 'details'] as const).map((type) => ({ type, group: 'layout' as const })),
  ...(['stat', 'table', 'list', 'steps', 'chart', 'diagram', 'timeline', 'codesteps', 'choice', 'form'] as const).map((type) => ({
    type,
    group: 'basic' as const
  })),
  ...(['quiz', 'flashcards', 'cloze'] as const).map((type) => ({ type, group: 'practice' as const })),
  ...(['calc'] as const).map((type) => ({ type, group: 'tool' as const })),
  ...(['schedule', 'tasks', 'note', 'excerpt', 'mastery', 'decision', 'usage'] as const).map((type) => ({ type, group: 'data' as const }))
].map((item) => ({ ...item, tiers: ['basic', 'strong'], minDensity: 'normal' }))

export function toChartData(node: Extract<UiNode, { type: 'chart' }>): ChartData {
  const { type: _type, kind, id: _id, cite: _cite, ...data } = node
  return { ...data, type: kind }
}
const unique = (items: string[]): boolean => new Set(items).size === items.length
export function checkUiNode(n: UiNode): string | null {
  let error: string | null = null
  switch (n.type) {
    case 'columns':
      if (n.ratio === '1:1:1' && n.children.length !== 3) error = '三栏必须有三个子节点'
      break
    case 'table': {
      const keys = n.columns.map((c) => c.key)
      if (!unique(keys) || n.rows.some((r) => Object.keys(r).some((k) => !keys.includes(k)))) error = '表格列不匹配'
      if (n.highlight?.some((h) => (h.row !== undefined && h.row >= n.rows.length) || (h.col !== undefined && !keys.includes(h.col))))
        error = '高亮位置不存在'
      break
    }
    case 'steps':
      if (n.current !== undefined && n.current >= n.items.length) error = '步骤不存在'
      break
    case 'chart':
      return checkChart(toChartData(n))
    case 'codesteps':
      return checkSteps(n)
    case 'choice':
      if (!unique(n.options.map((o) => o.value))) error = '选项值重复'
      break
    case 'form':
      if (!unique(n.fields.map((f) => f.key))) error = '字段键重复'
      else if (
        n.fields.some(
          (f) =>
            (f.kind === 'select' && !f.options?.length) ||
            (f.kind === 'slider' && (f.min === undefined || f.max === undefined)) ||
            (f.min !== undefined && f.max !== undefined && f.min >= f.max) ||
            (f.step !== undefined && f.step <= 0)
        )
      )
        error = '字段范围或选项有误'
      break
    case 'calc':
      if (!unique(n.inputs.map((f) => f.key)) || n.inputs.some((f) => f.min >= f.max || f.step <= 0 || f.value < f.min || f.value > f.max))
        error = '输入范围有误'
      else if (
        n.outputs.some(
          (o) =>
            !compileExpr(
              o.expr,
              n.inputs.map((i) => i.key)
            ).ok
        )
      )
        error = '公式有误'
      break
    case 'quiz':
      if (
        n.items.some((q) =>
          q.options
            ? typeof q.answer !== 'number' || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length
            : typeof q.answer !== 'string'
        )
      )
        error = '答案格式有误'
      break
    case 'cloze': {
      const blanks = n.text.match(/\{\{[^{}]+\}\}/g) ?? []
      if (blanks.length < 1 || blanks.length > 8) error = '填空数量有误'
      break
    }
    case 'schedule':
      if (n.range.from > n.range.to || (Date.parse(n.range.to) - Date.parse(n.range.from)) / 86400000 >= 14) error = '日程范围超过 14 天'
      else if (n.proposals?.some((p) => p.start >= p.end || p.start.slice(0, 10) < n.range.from || p.end.slice(0, 10) > n.range.to))
        error = '建议时间不在范围内'
      break
    case 'tasks':
      if (!n.filter && !n.drafts) error = '需要查询条件或建议'
      else if ((n.filter?.scope === 'goal' && !n.filter.goalId) || (n.filter?.scope === 'note' && !n.filter.noteId))
        error = '查询条件缺少 ID'
      break
    case 'excerpt':
      if (Number(n.cite !== undefined) + Number(n.segmentId !== undefined) !== 1) error = '只能指定一个出处'
      break
    case 'mastery':
      if (n.scope.kind !== 'all' && !n.scope.id) error = '需要范围 ID'
      break
    case 'decision':
      if (!n.decisionId) {
        if (!n.question || !n.options || !n.criteria || !n.scores) error = '决策数据不完整'
        else if (
          !unique(n.options.map((o) => o.id)) ||
          !unique(n.criteria.map((c) => c.name)) ||
          !unique(n.scores.map((s) => `${s.option}\0${s.criterion}`)) ||
          n.scores.some((s) => !n.options!.some((o) => o.id === s.option) || !n.criteria!.some((c) => c.name === s.criterion))
        )
          error = '评分引用不存在或重复'
      }
      break
  }
  if (error) return error
  for (const child of children(n)) {
    const e = checkUiNode(child)
    if (e) return e
  }
  return null
}
function children(n: UiNode): UiNode[] {
  return n.type === 'tabs' ? n.tabs.flatMap((t) => t.children) : n.type === 'columns' || n.type === 'details' ? n.children : []
}

/**
 * 解析围栏里的 JSON。模型偶尔在完整对象后多写一截（例如多关一个括号再接字段），
 * 这时取第一个完整的顶层对象；后面多出来的只要不长就忽略，否则仍按非法处理。
 */
export function parseUiJson(code: string): unknown {
  try {
    return JSON.parse(code)
  } catch (e) {
    const start = code.indexOf('{')
    if (start < 0) throw e
    let depth = 0,
      inString = false,
      escaped = false
    for (let i = start; i < code.length; i++) {
      const ch = code[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
      } else if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        if (code.length - i - 1 > 400) throw e
        return JSON.parse(code.slice(start, i + 1))
      }
    }
    throw e
  }
}

const toCite = (v: unknown): unknown => {
  const one = (x: unknown): unknown =>
    typeof x === 'string' && /^\[?\d{1,2}\]?$/.test(x.trim()) ? Number(x.trim().replace(/[[\]]/g, '')) : x
  if (Array.isArray(v)) return v.map(one)
  const n = one(v)
  return typeof n === 'number' ? [n] : v
}
const toOptions = (v: unknown): unknown =>
  Array.isArray(v) ? v.map((o) => (typeof o === 'string' || typeof o === 'number' ? { label: String(o), value: String(o) } : o)) : v
/**
 * 模型常见的“意思对、格式差一点”的写法，在校验前整理成标准形状，而不是整块退回成文字。
 * 只做无歧义的转换；拿不准的照旧交给校验报错。
 */
function coerce(n: Record<string, unknown>): Record<string, unknown> {
  if ('cite' in n && n.type !== 'excerpt') n.cite = toCite(n.cite)
  for (const key of ['items', 'cards'] as const)
    if (Array.isArray(n[key]))
      n[key] = (n[key] as unknown[]).map((it) =>
        it && typeof it === 'object' && 'cite' in it ? { ...it, cite: toCite((it as { cite: unknown }).cite) } : it
      )
  switch (n.type) {
    case 'choice':
      n.options = toOptions(n.options)
      break
    case 'form':
      if (Array.isArray(n.fields))
        n.fields = n.fields.map((f) => (f && typeof f === 'object' && 'options' in f ? { ...f, options: toOptions(f.options) } : f))
      break
    case 'calc':
      if (Array.isArray(n.inputs))
        n.inputs = n.inputs.map((i) =>
          i && typeof i === 'object' && (i as { kind?: unknown }).kind === 'range' ? { ...i, kind: 'slider' } : i
        )
      break
    case 'columns':
      // ratio 写成 [1,1] 或 "2:1" 之类：去掉，用默认等分
      if (n.ratio !== undefined && !['1:1', '382:618', '618:382', '1:1:1'].includes(n.ratio as string)) delete n.ratio
      break
    case 'table':
      // highlight 的 col 写成列序号：换成列的 key
      if (Array.isArray(n.highlight) && Array.isArray(n.columns)) {
        const cols = n.columns as { key?: unknown }[]
        n.highlight = n.highlight.map((h) =>
          h && typeof h === 'object' && typeof (h as { col?: unknown }).col === 'number'
            ? { ...h, col: cols[(h as { col: number }).col]?.key }
            : h
        )
      }
      break
    case 'excerpt':
      // cite 写成数字字符串转成编号；写成资料片段 ID 时当作 segmentId
      if (typeof n.cite === 'string') {
        const c = n.cite.trim().replace(/[[\]]/g, '')
        if (/^\d{1,2}$/.test(c)) n.cite = Number(c)
        else {
          if (!n.segmentId) n.segmentId = n.cite
          delete n.cite
        }
      }
      break
    case 'decision':
      // 已有决策从备忘录读选项和准则，模型附带的空数组不该让整块失败
      if (typeof n.decisionId === 'string' && n.decisionId) {
        delete n.options
        delete n.criteria
        delete n.scores
      }
      break
  }
  return n
}

export function parseUiNode(value: unknown): { ok: true; node: UiNode } | { ok: false; error: string } {
  try {
    const json = JSON.stringify(value)
    if (!json || new TextEncoder().encode(json).length > UI_LIMITS.bytes) return { ok: false, error: '组件数据过大' }
    let count = 0
    const normalize = (v: unknown, depth: number): unknown => {
      if (depth > UI_LIMITS.depth) throw new Error('组件嵌套过深')
      if (++count > UI_LIMITS.nodes) throw new Error('组件节点过多')
      if (!v || typeof v !== 'object' || Array.isArray(v)) return v
      const n = coerce({ ...v } as Record<string, unknown>)
      if (n.type === 'table' && Array.isArray(n.rows)) n.rows = n.rows.slice(0, 50)
      if ((n.type === 'columns' || n.type === 'details') && Array.isArray(n.children))
        n.children = n.children.map((c) => normalize(c, depth + 1))
      if (n.type === 'tabs' && Array.isArray(n.tabs))
        n.tabs = n.tabs.map((t) =>
          t && typeof t === 'object'
            ? { ...t, children: Array.isArray(t.children) ? t.children.map((c: unknown) => normalize(c, depth + 1)) : t.children }
            : t
        )
      return n
    }
    const r = TreeSchema.safeParse(normalize(value, 1))
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? '组件数据有误' }
    const error = checkUiNode(r.data)
    return error ? { ok: false, error } : { ok: true, node: r.data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '组件数据有误' }
  }
}
// 嵌入块的校验也遵守相同的字节、结构与树上限，不能只做表层 zod 检查。
export const UiNodeSchema = z.unknown().transform((value, ctx): UiNode => {
  const r = parseUiNode(value)
  if (r.ok) return r.node
  ctx.addIssue({ code: 'custom', message: r.error })
  return z.NEVER
})
export const UiEmbedSchema = z.object({
  node: UiNodeSchema,
  state: z.unknown().optional(),
  savedAt: z.number(),
  from: z.object({ conversationId: ref, messageId: ref }).optional()
})
export const uiEmbedText = (data: z.infer<typeof UiEmbedSchema>): string => uiToText(data.node)

export function partialUiNode(value: unknown): { type?: UiType; node: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { node: {} }
  const input = value as Record<string, unknown>,
    type = input.type as UiType
  if (!UI_TYPES.some((t) => t.type === type)) return { node: {} }
  const clean = (v: unknown, depth = 0): unknown => {
    if (depth > 8) return undefined
    if (Array.isArray(v))
      return v
        .filter((x) => !(x && typeof x === 'object' && (x as { [PARTIAL]?: true })[PARTIAL]))
        .slice(0, 60)
        .map((x) => clean(x, depth + 1))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, depth + 1)]))
    return v
  }
  const candidate = clean(input) as Record<string, unknown>,
    node: Record<string, unknown> = { type }
  const schema = LeafSchema.options.find((s) => s.shape.type.value === type)
  if (schema) {
    for (const [key, field] of Object.entries(schema.shape)) {
      const r = field.safeParse(candidate[key])
      if (r.success && r.data !== undefined) node[key] = r.data
    }
  } else {
    for (const [key, field] of Object.entries(Base)) {
      const r = field.safeParse(candidate[key])
      if (r.success && r.data !== undefined) node[key] = r.data
    }
    const validChildren = (items: unknown[]): UiNode[] =>
      items.slice(0, 3).flatMap((item) => {
        const r = parseUiNode(item)
        return r.ok ? [r.node] : []
      })
    if (type === 'tabs' && Array.isArray(candidate.tabs))
      node.tabs = candidate.tabs.slice(0, 5).flatMap((tab) => {
        if (!tab || typeof tab !== 'object' || typeof tab.label !== 'string' || tab.label.length > 20 || !Array.isArray(tab.children))
          return []
        return [{ label: tab.label, children: validChildren(tab.children) }]
      })
    if ((type === 'columns' || type === 'details') && Array.isArray(candidate.children)) node.children = validChildren(candidate.children)
    if (type === 'details' && typeof candidate.summary === 'string') node.summary = candidate.summary.slice(0, 80)
  }
  return { type, node }
}

/** 防止模型文字在退回时变成新的 Markdown 结构、HTML 或可执行围栏。 */
export function uiText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ')
}
function markdownTable(cols: string[], rows: unknown[][]): string {
  return [
    `| ${cols.map(uiText).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(uiText).join(' | ')} |`)
  ].join('\n')
}
export function uiToText(n: UiNode): string {
  const title = n.title ? `### ${uiText(n.title)}\n\n` : ''
  let body = ''
  switch (n.type) {
    case 'columns':
    case 'details':
      body = children(n).map(uiToText).join('\n\n')
      if (n.type === 'details') body = `${uiText(n.summary)}\n${body}`
      break
    case 'tabs':
      body = n.tabs.map((t) => `${uiText(t.label)}\n${t.children.map(uiToText).join('\n\n')}`).join('\n\n')
      break
    case 'stat':
      body = n.items
        .map((i) => `- ${uiText(i.label)}：${uiText(i.value)}${uiText(i.unit)}${i.delta ? ` (${uiText(i.delta)})` : ''}`)
        .join('\n')
      break
    case 'table':
      body = markdownTable(
        n.columns.map((c) => c.label),
        n.rows.map((r) => n.columns.map((c) => r[c.key]))
      )
      break
    case 'list':
      body = n.items
        .map(
          (i, k) =>
            `${n.ordered ? `${k + 1}.` : '-'} ${n.checkable ? `[${i.done ? 'x' : ' '}] ` : ''}${uiText(i.text)}${i.note ? ` — ${uiText(i.note)}` : ''}`
        )
        .join('\n')
      break
    case 'steps':
      body = n.items.map((i, k) => `${k + 1}. ${uiText(i.title)}${i.detail ? `：${uiText(i.detail)}` : ''}`).join('\n')
      break
    case 'chart':
      body = chartText(toChartData(n)).split('\n').map(uiText).join('\n')
      break
    case 'diagram':
      body = `\`\`\`mermaid\n${n.code.replace(/`/g, '\\`')}\n\`\`\``
      break
    case 'timeline':
      body = timelineText({ events: n.events }).split('\n').map(uiText).join('\n')
      break
    case 'codesteps':
      body = stepsText({ ...n, title: undefined })
        .split('\n')
        .map(uiText)
        .join('\n')
      break
    case 'choice':
      body = `${uiText(n.question)}\n${n.options.map((o) => `- ${uiText(o.label)}${o.hint ? `：${uiText(o.hint)}` : ''}`).join('\n')}`
      break
    case 'form':
      body = n.fields.map((f) => `- ${uiText(f.label)}：${uiText(f.value)}${f.required ? '（必填）' : ''}`).join('\n')
      break
    case 'calc': {
      const values = Object.fromEntries(n.inputs.map((i) => [i.key, i.value]))
      body = [
        ...n.inputs.map((i) => `- ${uiText(i.label)}：${i.value}${uiText(i.unit)}`),
        ...n.outputs.map((o) => {
          const c = compileExpr(o.expr, Object.keys(values)),
            result = c.ok ? c.run(values) : NaN
          return `- ${uiText(o.label)}：${Number.isFinite(result) ? result : '—'}${uiText(o.unit)} (${uiText(o.expr)})`
        })
      ].join('\n')
      break
    }
    case 'quiz':
      body = n.items
        .map(
          (q, i) =>
            `${i + 1}. ${uiText(q.q)}\n${q.options?.map((o, k) => `   ${k + 1}) ${uiText(o)}`).join('\n') ?? ''}\n   答案：${uiText(q.options ? q.options[q.answer as number] : q.answer)}\n   ${uiText(q.explain)}`
        )
        .join('\n')
      break
    case 'flashcards':
      body = n.cards.map((c, i) => `${i + 1}. ${uiText(c.front)}\n   ${uiText(c.back)}`).join('\n')
      break
    case 'cloze':
      body = `${uiText(n.text.replace(/\{\{([^{}]+)\}\}/g, '$1'))}${n.explain ? `\n${uiText(n.explain)}` : ''}`
      break
    case 'schedule':
      body = `${n.range.from} – ${n.range.to}\n${(n.proposals ?? []).map((p) => `- 建议：${uiText(p.title)} (${p.start} – ${p.end})`).join('\n')}`
      break
    case 'tasks':
      body =
        (n.drafts ?? []).map((d) => `- 建议：${uiText(d.title)}${d.due ? ` (${d.due})` : ''}`).join('\n') ||
        `待办：${uiText(n.filter?.scope)}`
      break
    case 'note':
      body = `笔记：${uiText(n.noteId)}`
      break
    case 'excerpt':
      body = n.cite ? `出处 [${n.cite}]` : `资料片段：${uiText(n.segmentId)}`
      break
    case 'mastery':
      body = `掌握度：${uiText(n.scope.kind)}${n.scope.id ? ` (${uiText(n.scope.id)})` : ''}`
      break
    case 'decision':
      body = n.decisionId
        ? `决策：${uiText(n.decisionId)}`
        : `${uiText(n.question)}\n${(n.options ?? []).map((o) => `- ${uiText(o.title)}`).join('\n')}\n${(n.criteria ?? []).map((c) => `${uiText(c.name)} (${c.weight})`).join('、')}`
      break
    case 'usage':
      body = n.range === 'today' ? '今天的用量' : '本月的用量'
      break
  }
  return [title + body, n.note ? uiText(n.note) : ''].filter(Boolean).join('\n')
}
export function uiFallbackMarkdown(value: unknown, raw: string): string {
  const r = parseUiNode(value)
  if (r.ok && r.node.type !== 'chart') return uiToText(r.node)
  if (!value || typeof value !== 'object') return uiText(raw)
  const n = value as Record<string, unknown>
  const title = typeof n.title === 'string' ? `### ${uiText(n.title)}\n\n` : ''
  if (n.type === 'chart') {
    const series = Array.isArray(n.series) ? n.series.filter((s) => s && typeof s === 'object' && Array.isArray(s.data)).slice(0, 12) : []
    const categories: unknown[] = Array.isArray(n.categories) ? n.categories.slice(0, 60) : []
    if (series.length)
      return (
        title +
        markdownTable(
          ['', ...series.map((s) => String(s.name ?? ''))],
          (categories.length ? categories : series[0].data.map((_v: unknown, i: number) => String(i + 1))).map((c: unknown, i: number) => [
            c,
            ...series.map((s) => (Array.isArray(s.data[i]) ? s.data[i].join(', ') : s.data[i]))
          ])
        )
      )
  }
  if (n.type === 'table' && Array.isArray(n.columns) && Array.isArray(n.rows)) {
    const cols = n.columns.filter((c) => c && typeof c === 'object').slice(0, 8)
    return (
      title +
      markdownTable(
        cols.map((c) => String(c.label ?? c.key ?? '')),
        n.rows
          .filter((row) => row && typeof row === 'object')
          .slice(0, 50)
          .map((row) => cols.map((c) => row[c.key]))
      )
    )
  }
  const text = ['question', 'summary', 'text', 'code', 'diagramTitle']
    .filter((k) => typeof n[k] === 'string')
    .map((k) => uiText(n[k]))
    .join('\n')
  if (text) return title + text
  const arrays = ['items', 'cards', 'proposals', 'drafts', 'children'].flatMap((key) => (Array.isArray(n[key]) ? n[key] : [])).slice(0, 60)
  if (arrays.length)
    return title + arrays.map((item) => `- ${uiFallbackMarkdown(item, JSON.stringify(item)).replace(/\n/g, ' ')}`).join('\n')
  return title + uiText(raw || JSON.stringify(n))
}
