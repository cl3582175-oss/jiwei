import type { Concept, ConceptSignal, MemoryKind } from '@shared/types'

// 记忆 v2 的纯函数部分（便于单元测试）：掌握度更新、文本相似度、敏感内容识别、淡出规则、JSON 提取。

/* ——— 学习者模型 ——— */

/** 第一次见到某个概念时的掌握度 */
export const MASTERY_START = 0.4

/**
 * 掌握度更新：请求解释略降，没听懂明显下降，表现出理解向 1 靠近。
 * 刻意简单、可解释；v0.4 的间隔复习（FSRS）会提供更可靠的信号。
 */
export function nextMastery(m: number, signal: ConceptSignal): number {
  const v = signal === 'asked' ? m * 0.9 : signal === 'confused' ? m * 0.7 : m + (1 - m) * 0.35
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
}

export const masteryLevel = (m: number): Concept['level'] => (m < 0.35 ? 'weak' : m < 0.7 ? 'learning' : 'solid')

/** 用户手动设定掌握程度时采用的值 */
export const LEVEL_MASTERY: Record<Concept['level'], number> = { weak: 0.2, learning: 0.5, solid: 0.85 }

/** 概念名归一化：去掉空白、引号、括号，统一大小写与全半角 */
export const normConcept = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』《》〈〉()（）[\]【】]/g, '')

/** 可以当作概念名的选区：2～24 个字、不是整句 */
export function isConceptLike(s: string): boolean {
  const t = s.trim()
  return t.length >= 2 && t.length <= 24 && !/[。！？.!?；;\n]/.test(t)
}

/* ——— 文本相似度（字二元组 Dice 系数，中英文都适用） ——— */

function bigrams(s: string): Map<string, number> {
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase()
  const m = new Map<string, number>()
  if (t.length < 2) {
    if (t) m.set(t, 1)
    return m
  }
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  let na = 0
  let nb = 0
  let both = 0
  for (const v of A.values()) na += v
  for (const [g, v] of B) {
    nb += v
    both += Math.min(v, A.get(g) ?? 0)
  }
  return na + nb ? (2 * both) / (na + nb) : 0
}

/**
 * AI 写入的内容过一段时间后的去向：
 * kept 基本没改；edited 被改写（给出改后的文字）；deleted 找不到了。
 */
export function classifyEdit(before: string, candidates: string[]): { kind: 'kept' | 'edited' | 'deleted'; after?: string } {
  let best = 0
  let after = ''
  for (const c of candidates) {
    const s = similarity(before, c)
    if (s > best) {
      best = s
      after = c
    }
  }
  if (best >= 0.97) return { kind: 'kept' }
  if (best >= 0.45) return { kind: 'edited', after }
  return { kind: 'deleted' }
}

/* ——— 敏感内容（AI 记下前先问） ——— */

const SENSITIVE =
  /病|症状|药|医院|医生|抑郁|焦虑症|怀孕|体检|诊断|残疾|工资|收入|存款|负债|贷款|欠款|房贷|离婚|恋爱|男朋友|女朋友|前任|伴侣|家暴|宗教|信仰|政治立场|性取向|health|illness|diagnos|medication|salary|income|debt|loan|divorce|boyfriend|girlfriend|religio|sexual/i
export const looksSensitive = (s: string): boolean => SENSITIVE.test(s)

/* ——— 淡出 ——— */

/** 超过这么多天没有被用到、也没有被更新的 AI 记忆会淡出（归档，可恢复） */
export const FADE_DAYS = 120
const FADE_KINDS: MemoryKind[] = ['preference', 'fact', 'glossary', 'skill']
const DAY = 86_400_000

export function shouldFade(
  r: { kind: MemoryKind; origin: string; pinned: boolean; status: string; updatedAt: number; lastUsedAt: number | null },
  now: number
): boolean {
  if (r.origin !== 'ai' || r.pinned || r.status !== 'active' || !FADE_KINDS.includes(r.kind)) return false
  return now - Math.max(r.updatedAt, r.lastUsedAt ?? 0) > FADE_DAYS * DAY
}

/* ——— 从模型文本中取出 JSON（结构化输出的退路） ——— */

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const a = body.indexOf('{')
  const b = body.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('No JSON object in model output')
  return JSON.parse(body.slice(a, b + 1))
}
