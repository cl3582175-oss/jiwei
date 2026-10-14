/*
 * 知识图谱的关系词表（v0.14.2）。一条关系存为 links 表的一行：from = A，to = B，读作“A <关系> B”。
 * 画面上按“家族”编码：关联、结构与顺序、推理、张力；有方向的关系画箭头。
 * 设计见 docs/design/v0.14.2-knowledge-graph.md。
 */
export const RELATIONS = [
  'related',
  'prerequisite',
  'part_of',
  'derived_from',
  'evidence',
  'applied_in',
  'contrasts',
  'contradicts',
  'supersedes'
] as const
export type Relation = (typeof RELATIONS)[number]
/** links.relation 里可能出现的全部值（reference 是正文里的链接） */
export type StoredRelation = Relation | 'reference'
export type RelationFamily = 'assoc' | 'structure' | 'reasoning' | 'tension'

interface RelationMeta {
  family: RelationFamily
  /** 箭头方向：forward = A→B，backward = B→A，none = 无方向 */
  arrow: 'forward' | 'backward' | 'none'
  /** 关系名（选择框里显示） */
  zh: string
  en: string
  /** 以 A 为主语的句子；{a}{b} 为两端标题 */
  zhSentence: string
  enSentence: string
}

export const RELATION_META: Record<Relation, RelationMeta> = {
  related: { family: 'assoc', arrow: 'none', zh: '相关', en: 'Related', zhSentence: '{a} 与 {b} 相关', enSentence: '{a} relates to {b}' },
  prerequisite: {
    family: 'structure',
    arrow: 'forward',
    zh: '前置',
    en: 'Prerequisite',
    zhSentence: '学 {b} 之前要先懂 {a}',
    enSentence: '{a} is a prerequisite of {b}'
  },
  part_of: {
    family: 'structure',
    arrow: 'forward',
    zh: '属于',
    en: 'Part of',
    zhSentence: '{a} 是 {b} 的一部分',
    enSentence: '{a} is part of {b}'
  },
  derived_from: {
    family: 'reasoning',
    arrow: 'backward',
    zh: '推出',
    en: 'Derived from',
    zhSentence: '由 {b} 推出 {a}',
    enSentence: '{a} is derived from {b}'
  },
  evidence: {
    family: 'reasoning',
    arrow: 'forward',
    zh: '例证',
    en: 'Evidence',
    zhSentence: '{a} 是 {b} 的例子或证据',
    enSentence: '{a} is evidence for {b}'
  },
  applied_in: {
    family: 'reasoning',
    arrow: 'forward',
    zh: '应用',
    en: 'Applied in',
    zhSentence: '{a} 应用在 {b}',
    enSentence: '{a} is applied in {b}'
  },
  contrasts: {
    family: 'tension',
    arrow: 'none',
    zh: '对比',
    en: 'Contrast',
    zhSentence: '{a} 与 {b} 容易混，要对照着看',
    enSentence: '{a} contrasts with {b}'
  },
  contradicts: {
    family: 'tension',
    arrow: 'none',
    zh: '矛盾',
    en: 'Contradicts',
    zhSentence: '{a} 与 {b} 的说法冲突',
    enSentence: '{a} contradicts {b}'
  },
  supersedes: {
    family: 'tension',
    arrow: 'forward',
    zh: '取代',
    en: 'Supersedes',
    zhSentence: '{a} 取代了 {b}',
    enSentence: '{a} supersedes {b}'
  }
}

export const asRelation = (r: string | null | undefined): Relation =>
  (RELATIONS as readonly string[]).includes(r ?? '') ? (r as Relation) : 'related'
export const familyOf = (r: string | null | undefined): RelationFamily => RELATION_META[asRelation(r)].family

/** 以 A、B 的标题生成一句关系说明 */
export function relationSentence(r: string, a: string, b: string, zh: boolean): string {
  const m = RELATION_META[asRelation(r)]
  return (zh ? m.zhSentence : m.enSentence)
    .replace('{a}', `《${a}》`)
    .replace('{b}', `《${b}》`)
    .replace(/《(.*?)》/g, zh ? '《$1》' : '“$1”')
}

/** 关系的显示箭头：返回 [起点, 终点]（无方向返回 null） */
export function arrowEnds(r: string, from: string, to: string): [string, string] | null {
  const m = RELATION_META[asRelation(r)]
  return m.arrow === 'none' ? null : m.arrow === 'forward' ? [from, to] : [to, from]
}
