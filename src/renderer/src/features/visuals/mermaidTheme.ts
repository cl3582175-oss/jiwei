import { mix, type Tokens } from './tokens'

/*
 * 示意图配色（v0.14 审查修订）。原来所有节点都是白底 + 强调色描边，结构和重点都看不出来。
 * 现在分两层：
 * 1. 主题变量：各类图（思维导图、时间线、饼图、四象限、时序图……）按分类色上色；
 * 2. 流程图按节点的“角色”自动上色：起点实色、判断姜黄、终点青碧、子图分组各用一色。
 *    模型可以用 :::key / good / warn / bad / muted / c1…c8 标出重点或分组，颜色仍由这里决定，
 *    模型自己写的 classDef 会被同名定义覆盖。
 */

export function mermaidThemeVariables(c: Tokens, fontSize = '14px'): Record<string, unknown> {
  const soft = c.vizSoft,
    line = mix(c.muted, c.surface, 0.75)
  const scale = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      [`cScale${i}`, soft[i % 8]],
      [`cScalePeer${i}`, c.viz[i % 8]],
      [`cScaleLabel${i}`, c.fg]
    ]).flat()
  )
  return {
    darkMode: !!c.dark,
    background: 'transparent',
    fontSize,
    textColor: c.fg,
    primaryColor: soft[0],
    primaryBorderColor: mix(c.viz[0], c.surface, 0.6),
    primaryTextColor: c.fg,
    secondaryColor: soft[1],
    secondaryBorderColor: mix(c.viz[1], c.surface, 0.6),
    secondaryTextColor: c.fg,
    tertiaryColor: soft[2],
    tertiaryBorderColor: mix(c.viz[2], c.surface, 0.6),
    tertiaryTextColor: c.fg,
    lineColor: line,
    defaultLinkColor: line,
    edgeLabelBackground: c.surface,
    clusterBkg: c.sunken,
    clusterBorder: c.borderStrong,
    titleColor: c.fg,
    nodeTextColor: c.fg,
    // 时序图
    actorBkg: soft[0],
    actorBorder: mix(c.viz[0], c.surface, 0.6),
    actorTextColor: c.fg,
    actorLineColor: c.borderStrong,
    signalColor: c.muted,
    signalTextColor: c.fg,
    labelBoxBkgColor: soft[4],
    labelBoxBorderColor: mix(c.viz[4], c.surface, 0.6),
    labelTextColor: c.fg,
    loopTextColor: c.fg,
    noteBkgColor: soft[5],
    noteBorderColor: mix(c.viz[5], c.surface, 0.6),
    noteTextColor: c.fg,
    activationBkgColor: soft[2],
    activationBorderColor: c.viz[2],
    sequenceNumberColor: c.accentFg,
    // 饼图、四象限、旅程、Git
    ...Object.fromEntries(c.viz.map((v, i) => [`pie${i + 1}`, v])),
    ...Object.fromEntries(c.viz.map((v, i) => [`pie${i + 9}`, soft[i]]).slice(0, 4)),
    pieStrokeColor: c.surface,
    pieStrokeWidth: '2px',
    pieOuterStrokeColor: c.border,
    pieTitleTextColor: c.fg,
    pieSectionTextColor: '#ffffff',
    pieLegendTextColor: c.fg,
    quadrant1Fill: soft[2],
    quadrant2Fill: soft[0],
    quadrant3Fill: c.sunken,
    quadrant4Fill: soft[5],
    quadrant1TextFill: c.fg,
    quadrant2TextFill: c.fg,
    quadrant3TextFill: c.fg,
    quadrant4TextFill: c.fg,
    quadrantPointFill: c.emph,
    quadrantPointTextFill: c.fg,
    quadrantTitleFill: c.fg,
    quadrantXAxisTextFill: c.muted,
    quadrantYAxisTextFill: c.muted,
    quadrantInternalBorderStrokeFill: c.border,
    quadrantExternalBorderStrokeFill: c.borderStrong,
    ...Object.fromEntries(soft.map((v, i) => [`fillType${i}`, v])),
    ...Object.fromEntries(c.viz.map((v, i) => [`git${i}`, v])),
    // 甘特图
    sectionBkgColor: c.sunken,
    altSectionBkgColor: c.surface,
    sectionBkgColor2: soft[0],
    taskBkgColor: soft[0],
    taskBorderColor: c.viz[0],
    taskTextColor: c.fg,
    taskTextDarkColor: c.fg,
    taskTextOutsideColor: c.fg,
    activeTaskBkgColor: soft[1],
    activeTaskBorderColor: c.viz[1],
    doneTaskBkgColor: c.sunken,
    doneTaskBorderColor: c.borderStrong,
    critBkgColor: soft[3],
    critBorderColor: c.viz[3],
    todayLineColor: c.emph,
    gridColor: c.border,
    // 状态图、类图、ER 图沿用 primary；状态图的起止点
    specialStateColor: c.muted,
    innerEndBackground: c.muted,
    ...scale
  }
}

/** 模型可用的类名（提示词里会告诉它）；颜色只在这里定义 */
export const DIAGRAM_CLASSES = ['key', 'good', 'warn', 'bad', 'muted', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] as const

function classDefs(c: Tokens): string[] {
  const soft = c.vizSoft,
    edge = (i: number): string => mix(c.viz[i], c.surface, 0.7)
  const def = (name: string, fill: string, stroke: string, text: string, width = '1.5px'): string =>
    `classDef ${name} fill:${fill},stroke:${stroke},color:${text},stroke-width:${width}`
  return [
    def('key', c.emph, c.emph, '#ffffff', '2px'),
    def('good', soft[7], c.viz[7], c.fg),
    def('warn', soft[5], c.viz[5], c.fg),
    def('bad', soft[3], c.viz[3], c.fg),
    def('muted', c.sunken, c.border, c.muted, '1px'),
    ...c.viz.map((v, i) => def(`c${i + 1}`, soft[i], edge(i), c.fg)),
    def('jwstart', c.viz[0], c.viz[0], '#ffffff', '2px'),
    def('jwend', soft[2], c.viz[2], c.fg, '2px'),
    def('jwdecide', soft[5], c.viz[5], c.fg)
  ]
}

type FlowDb = {
  getVertices(): Map<string, { id: string; type?: string; classes: string[] }>
  getEdges(): { start: string; end: string }[]
  getSubGraphs(): { id: string; nodes: string[]; classes: string[] }[]
}
type MermaidLike = { mermaidAPI: { getDiagramFromText(text: string): Promise<{ type: string; db: unknown }> } }

/** 流程图：按角色补上配色语句。解析失败或不是流程图时原样返回。 */
export async function decorateDiagram(code: string, mermaid: MermaidLike, c: Tokens): Promise<string> {
  if (!/^\s*(?:%%[^\n]*\n\s*)*(?:graph|flowchart)\b/i.test(code)) return code
  let db: FlowDb
  try {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(code)
    db = diagram.db as FlowDb
    if (typeof db.getVertices !== 'function') return code
  } catch {
    return code
  }
  const vertices = [...db.getVertices().values()]
  const edges = db.getEdges()
  const subgraphs = db.getSubGraphs()
  const safe = (id: string): boolean => /^[\p{L}\p{N}_-]+$/u.test(id)
  const lines = classDefs(c)
  const assign = new Map<string, string[]>()
  const put = (cls: string, id: string): void => {
    if (safe(id)) assign.set(cls, [...(assign.get(cls) ?? []), id])
  }
  // 子图：每组一色，组内节点用同色浅底，子图本身只留很淡的底色和描边
  const group = new Map<string, number>()
  subgraphs.forEach((sg, i) => {
    const k = i % 8
    if (safe(sg.id) && !sg.classes.length)
      lines.push(
        `style ${sg.id} fill:${mix(c.viz[k], c.surface, c.dark ? 0.1 : 0.05)},stroke:${mix(c.viz[k], c.surface, 0.55)},color:${c.fg}`
      )
    for (const id of sg.nodes) if (!group.has(id)) group.set(id, k)
  })
  const ins = new Map<string, number>(),
    outs = new Map<string, number>()
  for (const e of edges) {
    outs.set(e.start, (outs.get(e.start) ?? 0) + 1)
    ins.set(e.end, (ins.get(e.end) ?? 0) + 1)
  }
  const roles = edges.length > 0 && vertices.length > 2
  for (const v of vertices) {
    if (v.classes.some((cls) => cls !== 'default') || subgraphs.some((sg) => sg.id === v.id)) continue
    const k = group.get(v.id)
    if (v.type === 'diamond') put('jwdecide', v.id)
    else if (k !== undefined) put(`c${k + 1}`, v.id)
    else if (roles && !ins.get(v.id) && outs.get(v.id)) put('jwstart', v.id)
    else if (roles && !outs.get(v.id) && ins.get(v.id)) put('jwend', v.id)
  }
  for (const [cls, ids] of assign) lines.push(`class ${ids.join(',')} ${cls}`)
  return `${code.replace(/\s*$/, '')}\n${lines.join('\n')}\n`
}
