import {
  ChartColumn,
  Calculator,
  CalendarRange,
  ClipboardList,
  Code2,
  Columns2,
  ChevronsUpDown,
  Hash,
  Layers,
  ListChecks,
  ListOrdered,
  Milestone,
  MessageCircleQuestion,
  NotebookText,
  PanelTop,
  Quote,
  Scale,
  SquareCheckBig,
  Table2,
  Target,
  TextCursorInput,
  Wallet,
  Workflow,
  CircleHelp,
  type LucideIcon
} from 'lucide-react'

/*
 * 组件框左上角的类型标记：按“用途”分色，同一类用途一个颜色，扫一眼就知道这块是看懂、看数、练习还是要动手。
 * 颜色取自 --viz-*（与图表同一套），不用品牌绿，避免整页一片绿。
 */
const KINDS: Record<string, [LucideIcon, number]> = {
  // 看懂：黛蓝
  diagram: [Workflow, 1],
  steps: [ListOrdered, 1],
  timeline: [Milestone, 1],
  codesteps: [Code2, 1],
  // 看数：赭橙
  chart: [ChartColumn, 2],
  stat: [Hash, 2],
  table: [Table2, 2],
  // 去做：青碧
  list: [ListChecks, 3],
  schedule: [CalendarRange, 3],
  tasks: [SquareCheckBig, 3],
  // 练习：藤紫
  quiz: [CircleHelp, 5],
  flashcards: [Layers, 5],
  cloze: [TextCursorInput, 5],
  // 工具：姜黄
  calc: [Calculator, 6],
  decision: [Scale, 6],
  // 问清：胭脂
  choice: [MessageCircleQuestion, 7],
  form: [ClipboardList, 7],
  // 你的数据：竹绿
  note: [NotebookText, 8],
  excerpt: [Quote, 8],
  mastery: [Target, 8],
  usage: [Wallet, 8],
  // 布局：不上色
  columns: [Columns2, 0],
  tabs: [PanelTop, 0],
  details: [ChevronsUpDown, 0]
}

export function UiTypeIcon({ type }: { type?: string }) {
  const kind = type ? KINDS[type] : undefined
  if (!kind) return null
  const [Icon, slot] = kind
  const color = slot ? `var(--viz-${slot})` : 'var(--fg-subtle)'
  return (
    <span
      aria-hidden="true"
      data-testid="ui-type-icon"
      className="grid size-6 shrink-0 place-items-center rounded-md"
      style={{ color, background: `color-mix(in oklab, ${color} 13%, transparent)` }}
    >
      <Icon className="size-3.5" strokeWidth={2.2} />
    </span>
  )
}
