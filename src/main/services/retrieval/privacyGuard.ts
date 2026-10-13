import { getSqlite } from '../../db'
import { tr } from '../../lib/messages'

export class PrivacyError extends Error {
  constructor() {
    super(tr('搜索词里含有你设为“不给 AI”的内容，已拦截', 'The query contains content you excluded from AI; blocked'))
    this.name = 'PrivacyError'
  }
}

const TITLES_SQL = `SELECT title FROM notes WHERE ai_excluded = 1 AND deleted_at IS NULL
  UNION ALL SELECT title FROM sources WHERE ai_excluded = 1 AND deleted_at IS NULL`
const BODY_MATCH_SQL = `SELECT 1 FROM notes
  WHERE ai_excluded = 1 AND deleted_at IS NULL AND instr(lower(plain_text), lower(?)) > 0
  UNION ALL SELECT 1 FROM source_segments AS segment JOIN sources AS source ON source.id = segment.source_id
  WHERE source.ai_excluded = 1 AND source.deleted_at IS NULL AND instr(lower(segment.text), lower(?)) > 0
  LIMIT 1`

function* windows(q: string): Generator<string> {
  if (/\p{Script=Han}/u.test(q)) {
    // 以字符计数，避免扩展汉字被 UTF-16 的两个码元拆开。
    const characters = Array.from(q)
    for (let i = 0; i + 10 <= characters.length; i++) yield characters.slice(i, i + 10).join('')
  } else {
    const words = Array.from(q.matchAll(/\S+/gu))
    for (let i = 0; i + 4 <= words.length; i++) {
      const last = words[i + 3]
      // 保留窗口原文，SQL 按字面匹配，不把内容改写成另一段搜索词。
      yield q.slice(words[i].index, last.index + last[0].length)
    }
  }
}

/** false 表示查询含排除内容；只读取必要的标题，不将私人正文或查询写入日志。 */
export function check(q: string): boolean {
  const db = getSqlite(),
    titles = db.prepare(TITLES_SQL).all() as { title: string }[]
  // 必须先查元数据才能知道排除集合是否为空；空集合不准备或扫描正文查询。
  if (!titles.length) return true
  const lower = q.toLowerCase()
  if (titles.some(({ title }) => Array.from(title).length >= 4 && lower.includes(title.toLowerCase()))) return false
  const match = db.prepare(BODY_MATCH_SQL),
    seen = new Set<string>()
  for (const window of windows(q)) {
    if (seen.has(window)) continue
    seen.add(window)
    if (match.get(window, window)) return false
  }
  return true
}
