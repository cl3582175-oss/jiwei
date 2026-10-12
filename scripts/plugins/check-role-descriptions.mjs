import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import console from 'node:console'

// 只作为描述重叠预警，不把字符串相似度当作语义质量验收。
const threshold = 0.55
const skills = []
async function scan(root, role) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, 'SKILL.md')
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') continue
      throw e
    }
    const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!front) continue
    const data = parse(front[1])
    if (data.metadata?.kind === 'lens') continue
    skills.push({ id: `${role ?? 'builtin'}:${data.name}`, role: !!role, description: data.description })
  }
}
await scan('resources/skills')
for (const entry of await readdir('resources/marketplace/plugins'))
  if (entry.startsWith('role-')) await scan(join('resources/marketplace/plugins', entry, 'skills'), entry)
const grams = (s) => {
  const text = s.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
  return new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)))
}
const pairs = []
for (let i = 0; i < skills.length; i++)
  for (let j = i + 1; j < skills.length; j++) {
    if (!skills[i].role && !skills[j].role) continue
    const a = grams(skills[i].description),
      b = grams(skills[j].description)
    const intersection = [...a].filter((s) => b.has(s)).length
    const score = intersection / (a.size + b.size - intersection || 1)
    pairs.push({ a: skills[i].id, b: skills[j].id, score: Number(score.toFixed(4)) })
  }
pairs.sort((a, b) => b.score - a.score)
const alerts = pairs.filter((p) => p.score >= threshold)
console.log(
  JSON.stringify(
    {
      method: 'Unicode character bigram Jaccard; role-role and role-builtin pairs',
      threshold,
      roles: skills.filter((s) => s.role).length,
      builtin: skills.filter((s) => !s.role).length,
      compared: pairs.length,
      alerts,
      top: pairs.slice(0, 10)
    },
    null,
    2
  )
)
if (alerts.length) console.warn(`Description similarity alert: ${alerts.length} pairs require editorial review.`)
