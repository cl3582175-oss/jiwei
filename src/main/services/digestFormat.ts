import { z } from 'zod'

export interface Points {
  topic: string
  points: { text: string; segmentId?: string }[]
}
const cut = (text: string, length: number): string => [...text.trim()].slice(0, length).join('')

/** 模型正文按行读；未知引用不使合格的要点失效。 */
export function parsePointLines(text: string, validIds: Set<string>): Points {
  const result: Points = { topic: '', points: [] }
  for (const line of text.split(/\r?\n/).map((s) => s.trim())) {
    if (/^#+\s*/.test(line) && !result.topic) {
      result.topic = cut(line.replace(/^#+\s*/, ''), 60)
      continue
    }
    const match = /^(?:[-*•]|\d+[.)、．]|[（(]\d+[）)])\s*(.+)$/.exec(line)
    if (!match) continue
    let segmentId: string | undefined
    const body = match[1]
      .replace(/[{｛（(【[]([^}｝）)】\]]+)[}｝）)】\]]/g, (ref, id: string) => {
        id = id.trim()
        if (validIds.has(id)) {
          segmentId ??= id
          return ''
        }
        return /^[\w-]+$/.test(id) ? '' : ref
      })
      .trim()
    if (!body) continue
    result.points.push({ text: cut(body, 60), ...(segmentId ? { segmentId } : {}) })
    if (result.points.length === 12) break
  }
  return result
}

export interface DigestTree {
  text: string
  segmentId?: string
  children?: DigestTree[]
}
export const DigestTreeSchema: z.ZodType<DigestTree> = z.lazy(() =>
  z.object({
    text: z.string().min(1),
    segmentId: z.string().optional(),
    children: z.array(DigestTreeSchema).optional()
  })
)

/** 广度优先裁剪，保证顶层分支不会被前一个分支的深层节点挤掉。 */
export function normalizeMindmap(tree: DigestTree, validIds: Set<string>): DigestTree {
  const node = (n: DigestTree, root = false): DigestTree => ({
    text: cut(n.text, root ? 12 : 15),
    ...(n.segmentId && validIds.has(n.segmentId) ? { segmentId: n.segmentId } : {})
  })
  const root = node(tree, true)
  const queue = [{ input: tree, output: root, depth: 0 }]
  let count = 1
  for (let i = 0; i < queue.length && count < 45; i++) {
    const current = queue[i]
    if (current.depth >= 2) continue
    for (const child of (current.input.children ?? []).slice(0, current.depth ? 12 : 8)) {
      if (count >= 45) break
      const output = node(child)
      ;(current.output.children ??= []).push(output)
      queue.push({ input: child, output, depth: current.depth + 1 })
      count++
    }
  }
  return root
}

export const DigestOutlineSchema = z.object({
  rows: z
    .array(
      z.object({
        cue: z.string().min(1),
        body: z.string().min(1),
        segmentIds: z.array(z.string())
      })
    )
    .min(1)
})
export function normalizeOutline(rows: z.infer<typeof DigestOutlineSchema>['rows'], validIds: Set<string>) {
  return rows
    .filter((r) => r.cue.trim() && r.body.trim())
    .slice(0, 24)
    .map((r) => ({
      cue: cut(r.cue, 200),
      body: cut(r.body, 2000),
      segmentIds: [...new Set(r.segmentIds.filter((id) => validIds.has(id)))].slice(0, 12)
    }))
}
