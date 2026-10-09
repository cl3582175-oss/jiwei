// 关键词检索的查询构造（纯函数，便于测试）。

/**
 * 提问中的虚词与疑问词（“有什么”“为什么”“怎么样”）：由它们组成的三字片段几乎每个问题都有，
 * 会让无关内容凭这些字排到前面（检索评估中发现），不作为关键词。
 */
const STOP_CHARS = new Set('的了吗呢吧啊呀是在有和与及或把被就也都还又很最更太什么怎为哪如何些个这那其吧要会能可以该'.split(''))
export const isStopTrigram = (t: string): boolean => [...t].filter((c) => STOP_CHARS.has(c)).length >= 2

/** 把问题切成 trigram 关键词（中文按 3 字窗口、英文按单词）组成 OR 查询 */
export function ftsQuery(q: string): string | null {
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
