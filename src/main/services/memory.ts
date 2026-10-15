import { profileDb } from '../db/profile'
import { newId } from '../lib/ids'
import { emit } from '../events'
import { shouldFade } from '../lib/learner'
import { PROFILE_KEYS, type Memory, type MemoryKind, type MemorySettings, type ProfileKey } from '@shared/types'
import type { MemoryInput, MemoryQuery } from '@shared/schemas'

// 记忆：让积微“越用越懂你”。设计见 docs/design/v0.3-agent.md §5。
// v1：个人档案（用户预设）+ 用户或 AI 记下的偏好、事实、术语、技能偏好；常驻“用户卡片”+ 按需检索。
// v2：对话后自动整理（memoryLearn.ts）、学习者模型（learner.ts）、学习经历、技能偏好学习、淡出。

type Row = {
  id: string
  project_id: string | null
  kind: MemoryKind
  key: string | null
  skill: string | null
  content: string
  sensitive: number
  status: Memory['status']
  pinned: number
  origin: Memory['origin']
  evidence: string | null
  created_at: number
  updated_at: number
  last_used_at: number | null
  use_count: number
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  key: r.key,
  skill: r.skill,
  content: r.content,
  sensitive: !!r.sensitive,
  status: r.status,
  pinned: !!r.pinned,
  origin: r.origin,
  evidence: r.evidence ? (JSON.parse(r.evidence) as Memory['evidence']) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count
})

const norm = (s: string): string => s.replace(/[\s，。,.!！?？;；:："“”'’]/g, '').toLowerCase()

export type MemoryScope = { projectId?: string | null }

export function listMemories(q: MemoryQuery = {}): Memory[] {
  const db = profileDb()
  const where: string[] = ['project_id IS ?']
  const args: unknown[] = [q.projectId ?? null]
  if (q.kind) {
    where.push('kind = ?')
    args.push(q.kind)
  }
  if (q.status) {
    where.push('status = ?')
    args.push(q.status)
  } else where.push("status != 'archived'")
  if (q.search?.trim()) {
    where.push('content LIKE ?')
    args.push(`%${q.search.trim()}%`)
  }
  const rows = db
    .prepare(`SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pinned DESC, updated_at DESC LIMIT 500`)
    .all(...args) as Row[]
  return rows.map(toMemory)
}

export function getMemory(id: string): Memory | null {
  const r = profileDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined
  return r ? toMemory(r) : null
}

/**
 * 新增或修改记忆。
 * - 有 id：修改；有 key（如个人档案）：同 kind+key 覆盖；
 * - AI 记下的内容与已有记忆实质相同时不重复新增，只刷新时间；
 * - 敏感内容由 AI 记下时进入“待确认”。
 */
export function saveMemory(
  input: MemoryInput,
  origin: Memory['origin'],
  evidence?: Memory['evidence'],
  opts: MemoryScope & { silent?: boolean } = {}
): Memory {
  const db = profileDb()
  const now = Date.now()
  const content = input.content.trim()
  // 档案永远属于用户；按 ID 的管理操作只修改内容，绝不暗中迁移所属项目。
  const projectId = input.kind === 'profile' ? null : opts.projectId !== undefined ? opts.projectId : (input.projectId ?? null)
  let existing: Row | undefined
  if (input.id) existing = db.prepare('SELECT * FROM memories WHERE id = ?').get(input.id) as Row | undefined
  else if (input.key)
    existing = db.prepare('SELECT * FROM memories WHERE kind = ? AND key = ? AND project_id IS ?').get(input.kind, input.key, projectId) as
      Row | undefined
  else {
    const n = norm(content)
    existing = (
      db
        .prepare("SELECT * FROM memories WHERE kind = ? AND status != 'archived' AND skill IS ? AND project_id IS ?")
        .all(input.kind, input.skill ?? null, projectId) as Row[]
    ).find((r) => norm(r.content) === n)
  }
  const sensitive = input.sensitive ?? !!existing?.sensitive
  const status: Memory['status'] = input.status ?? (existing ? existing.status : origin === 'ai' && sensitive ? 'pending' : 'active')

  if (existing) {
    db.prepare(
      'UPDATE memories SET content = ?, skill = ?, sensitive = ?, status = ?, pinned = ?, updated_at = ?, invalid_at = NULL WHERE id = ?'
    ).run(content, input.skill ?? existing.skill, sensitive ? 1 : 0, status, (input.pinned ?? !!existing.pinned) ? 1 : 0, now, existing.id)
    if (!opts.silent) emit('memory:changed', {})
    return getMemory(existing.id)!
  }
  const id = newId()
  db.prepare(
    `INSERT INTO memories (id, kind, key, skill, content, sensitive, status, pinned, origin, evidence, valid_from, created_at, updated_at, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.kind,
    input.key ?? null,
    input.skill ?? null,
    content,
    sensitive ? 1 : 0,
    status,
    input.pinned ? 1 : 0,
    origin,
    evidence ? JSON.stringify(evidence) : null,
    now,
    now,
    now,
    projectId
  )
  const m = getMemory(id)!
  if (!opts.silent) emit('memory:changed', origin === 'ai' && m.projectId === null ? { added: m } : {})
  return m
}

/** 项目改为默认记忆时保留所有记录；键冲突时给晋升的行分配稳定的新键。由项目服务统一广播。 */
export function promoteProjectMemories(projectId: string): number {
  const db = profileDb()
  return db.transaction(() => {
    const rows = db.prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY id').all(projectId) as Row[]
    const collision = db.prepare('SELECT 1 FROM memories WHERE project_id IS NULL AND kind = ? AND key = ?')
    const promote = db.prepare('UPDATE memories SET project_id = NULL, key = ? WHERE id = ? AND project_id = ?')
    for (const row of rows) {
      let key = row.key
      if (key !== null && collision.get(row.kind, key)) {
        const base = `promoted:${row.id}`.slice(0, 54)
        key = base
        for (let suffix = 1; collision.get(row.kind, key); suffix++) key = `${base}:${suffix}`
      }
      promote.run(key, row.id, projectId)
    }
    db.prepare('UPDATE skill_feedback SET project_id = NULL WHERE project_id = ?').run(projectId)
    return rows.length
  })()
}

/** 删除项目时同时清除尚未归纳的反馈；反复执行不会影响其他项目或全局记录。 */
export function deleteProjectMemories(projectId: string): number {
  const db = profileDb()
  return db.transaction(() => {
    db.prepare('DELETE FROM skill_feedback WHERE project_id = ?').run(projectId)
    return db.prepare('DELETE FROM memories WHERE project_id = ?').run(projectId).changes
  })()
}

export function removeMemory(id: string): void {
  profileDb().prepare('DELETE FROM memories WHERE id = ?').run(id)
  emit('memory:changed', {})
}

export function confirmMemory(id: string): Memory | null {
  profileDb().prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), id)
  emit('memory:changed', {})
  return getMemory(id)
}

/* ——— 个人档案 ——— */

export function getUserProfile(): Partial<Record<ProfileKey, string>> {
  const rows = profileDb()
    .prepare("SELECT key, content FROM memories WHERE kind = 'profile' AND key IS NOT NULL AND project_id IS NULL")
    .all() as {
    key: string
    content: string
  }[]
  return Object.fromEntries(rows.filter((r) => (PROFILE_KEYS as readonly string[]).includes(r.key)).map((r) => [r.key, r.content]))
}

export function setUserProfile(patch: Partial<Record<ProfileKey, string>>): Partial<Record<ProfileKey, string>> {
  const db = profileDb()
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (!value.trim()) db.prepare("DELETE FROM memories WHERE kind = 'profile' AND key = ? AND project_id IS NULL").run(key)
    else saveMemory({ kind: 'profile', key, content: value }, 'user')
  }
  emit('memory:changed', {})
  emit('memory:profileChanged', {})
  return getUserProfile()
}

/* ——— 供 AI 使用 ——— */

/** 检索记忆（全文 trigram；短词用 LIKE），并记录使用 */
export function searchMemories(query: string, limit = 8, opts: MemoryScope = {}): Memory[] {
  const db = profileDb()
  const q = query.trim()
  if (!q) return []
  const projectId = opts.projectId ?? null
  let rows: Row[]
  if (q.length >= 3) {
    const terms = q
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
    rows = terms.length
      ? (db
          .prepare(
            `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.status = 'active' AND m.project_id IS ? ORDER BY rank LIMIT ?`
          )
          .all(terms.join(' OR '), projectId, limit) as Row[])
      : []
  } else rows = []
  if (rows.length < limit) {
    const like = db
      .prepare("SELECT * FROM memories WHERE status = 'active' AND content LIKE ? AND project_id IS ? ORDER BY updated_at DESC LIMIT ?")
      .all(`%${q.slice(0, 20)}%`, projectId, limit) as Row[]
    for (const r of like) if (!rows.some((x) => x.id === r.id)) rows.push(r)
  }
  rows = rows.slice(0, limit)
  markUsed(rows.map((r) => r.id))
  return rows.map(toMemory)
}

/** 某个技能的输出偏好 */
export function skillPreferences(skill: string, opts: MemoryScope = {}): string[] {
  return (
    profileDb()
      .prepare(
        "SELECT content FROM memories WHERE kind = 'skill' AND skill = ? AND status = 'active' AND project_id IS ? ORDER BY created_at"
      )
      .all(skill, opts.projectId ?? null) as {
      content: string
    }[]
  ).map((r) => r.content)
}

export function markUsed(ids: string[]): void {
  if (!ids.length) return
  const stmt = profileDb().prepare('UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
  const now = Date.now()
  for (const id of ids) stmt.run(now, id)
}

const PROFILE_LABEL: Record<ProfileKey, [string, string]> = {
  role: ['身份', 'Who I am'],
  goals: ['方向', 'Learning goals'],
  background: ['已有基础', 'Background'],
  style: ['回答偏好', 'Answer style'],
  avoid: ['请避免', 'Please avoid']
}
const KIND_LABEL: Partial<Record<MemoryKind, [string, string]>> = {
  preference: ['偏好', 'Preferences'],
  fact: ['关于我', 'About me'],
  glossary: ['我的术语', 'My terms']
}

/** 卡片字数上限（约 600 token） */
const CARD_BUDGET = 1200

/**
 * 常驻“用户卡片”：个人档案 + 钉住的 + 最常用的偏好 / 事实 / 术语。
 * 排序确定，内容不变时字节相同，便于命中模型服务的前缀缓存。
 */
export function userCard(zh: boolean, opts: MemoryScope = {}): string | null {
  const db = profileDb()
  const profile = getUserProfile()
  const lines: string[] = []
  for (const k of PROFILE_KEYS) if (profile[k]) lines.push(`- ${PROFILE_LABEL[k][zh ? 0 : 1]}：${profile[k]}`)
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE status = 'active' AND kind IN ('preference', 'fact', 'glossary') AND project_id IS ?
       ORDER BY pinned DESC, use_count DESC, created_at ASC LIMIT 60`
    )
    .all(opts.projectId ?? null) as Row[]
  let used = lines.join('\n').length
  const groups = new Map<MemoryKind, string[]>()
  for (const r of rows) {
    const line = `  - ${r.content}`
    if (used + line.length > CARD_BUDGET) break
    used += line.length
    groups.set(r.kind, [...(groups.get(r.kind) ?? []), line])
  }
  for (const [kind, ls] of groups) lines.push(`- ${KIND_LABEL[kind]![zh ? 0 : 1]}：`, ...ls)
  // 最近的学习经历（每条截短），帮助接上“上次学到哪”
  const episodes = db
    .prepare(
      "SELECT content FROM memories WHERE status = 'active' AND kind = 'episode' AND project_id IS ? ORDER BY updated_at DESC LIMIT 3"
    )
    .all(opts.projectId ?? null) as { content: string }[]
  if (episodes.length && used < CARD_BUDGET)
    lines.push(`- ${zh ? '最近在学' : 'Recently studied'}：`, ...episodes.map((e) => `  - ${e.content.slice(0, 80)}`))
  return lines.length ? lines.join('\n') : null
}

/* ——— 个人设置（存于个人数据库，随人不随知识库） ——— */

export function getMemorySettings(): MemorySettings {
  const rows = profileDb().prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return { autoLearn: m.autoLearn !== '0', learnSkills: m.learnSkills !== '0' }
}

export function setMemorySettings(patch: Partial<MemorySettings>): MemorySettings {
  const stmt = profileDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const [k, v] of Object.entries(patch)) if (typeof v === 'boolean') stmt.run(k, v ? '1' : '0')
  return getMemorySettings()
}

export function getMeta(key: string): string | null {
  return (profileDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}
export function setMeta(key: string, value: string): void {
  profileDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/* ——— 淡出：长期没用到的 AI 记忆归档（可在「关于我」中恢复） ——— */

export function fadeMemories(now = Date.now()): number {
  const db = profileDb()
  const rows = db.prepare("SELECT * FROM memories WHERE status = 'active' AND origin = 'ai' AND pinned = 0").all() as Row[]
  const fade = rows.filter((r) =>
    shouldFade(
      { kind: r.kind, origin: r.origin, pinned: !!r.pinned, status: r.status, updatedAt: r.updated_at, lastUsedAt: r.last_used_at },
      now
    )
  )
  const stmt = db.prepare("UPDATE memories SET status = 'archived', invalid_at = ? WHERE id = ?")
  db.transaction(() => fade.forEach((r) => stmt.run(now, r.id)))()
  if (fade.length) emit('memory:changed', {})
  return fade.length
}
