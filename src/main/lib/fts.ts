// 关键词检索的查询构造（纯函数，便于测试）。
import { normalizeQuery } from './textNormalize'

/**
 * 提问中的虚词与疑问词（“有什么”“为什么”“怎么样”）：由它们组成的三字片段几乎每个问题都有，
 * 会让无关内容凭这些字排到前面（检索评估中发现），不作为关键词。
 */
const STOP_CHARS = new Set('的了吗呢吧啊呀是在有和与及或把被就也都还又很最更太什么怎为哪如何些个这那其吧要会能可以该'.split(''))
export const isStopTrigram = (t: string): boolean => [...t].filter((c) => STOP_CHARS.has(c)).length >= 2

/** 把问题切成 trigram 关键词（中文按 3 字窗口、英文按单词）组成 OR 查询 */
export function ftsQuery(q: string): string | null {
  q = normalizeQuery(q)
  const terms = new Set<string>()
  for (const run of q.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length < 3) continue
    for (let i = 0; i + 3 <= run.length; i++) {
      const t = run.slice(i, i + 3)
      if (!isStopTrigram(t)) terms.add(t)
    }
  }
  for (const w of q.match(/[A-Za-z0-9_]{3,}/g) ?? []) terms.add(w.toLowerCase())
  const list = [...terms].slice(0, 40)
  return list.length ? list.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ') : null
}

/** 用户指定的短语/资料名/编号，保留原顺序；查询方仍须绑定 SQL 参数。 */
export function exactTerms(q: string): string[] {
  q = normalizeQuery(q)
  const matches: { index: number; text: string }[] = []
  for (const m of q.matchAll(/「([^」]{2,60})」|『([^』]{2,60})』|“([^”]{2,60})”|"([^"]{2,60})"|《([^》]{2,60})》/gu)) {
    matches.push({ index: m.index!, text: m.slice(1).find((s) => s !== undefined)! })
  }
  const standards = [...q.matchAll(/[A-Za-z]+(?:\/[A-Za-z]+)?\s+\d[A-Za-z\d_/.-]*/g)]
  for (const m of standards) if (m[0].length >= 4) matches.push({ index: m.index!, text: m[0] })
  for (const m of q.matchAll(/[A-Za-z\d](?:[A-Za-z\d_/.-]*[A-Za-z\d])?/g)) {
    if (m[0].length >= 4 && /\d/.test(m[0]) && !standards.some((s) => m.index! >= s.index! && m.index! < s.index! + s[0].length))
      matches.push({ index: m.index!, text: m[0] })
  }
  return [...new Set(matches.sort((a, b) => a.index - b.index).map((m) => m.text))].slice(0, 5)
}

export function shortTerms(q: string): string[] {
  const terms = new Set<string>()
  const questionWords = new Set(['多少', '是否', '哪里', '何时', '几时', '哪个', '为何', '怎么'])
  for (const run of normalizeQuery(q).match(/\p{Script=Han}+/gu) ?? []) {
    const parts = run.length === 2 ? [run] : run.split(new RegExp(`[${[...STOP_CHARS].join('')}]`, 'u'))
    for (const part of parts)
      if ([...part].length === 2 && !questionWords.has(part) && ![...part].some((c) => STOP_CHARS.has(c))) terms.add(part)
  }
  return [...terms].slice(0, 6)
}
