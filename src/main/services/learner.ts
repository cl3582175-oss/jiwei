import { profileDb } from '../db/profile'
import { newId } from '../lib/ids'
import { emit } from '../events'
import { LEVEL_MASTERY, MASTERY_START, masteryLevel, nextMastery, normConcept } from '../lib/learner'
import type { Concept, ConceptSignal } from '@shared/types'
import { memoryProjectId } from './ai/memoryScope'

// 学习者模型：每个概念的掌握度，由行为信号累积（请求解释、没听懂、表现出理解）。
// 用途：回答时据此调整讲解深浅；「关于我」中可查看、校正；v0.4 的复习与掌握度地图在此基础上扩展。

type Row = {
  id: string
  name: string
  norm: string
  mastery: number
  asked: number
  confused: number
  understood: number
  note: string | null
  first_seen: number
  last_seen: number
}

const toConcept = (r: Row): Concept => ({
  id: r.id,
  name: r.name,
  mastery: r.mastery,
  level: masteryLevel(r.mastery),
  asked: r.asked,
  confused: r.confused,
  understood: r.understood,
  note: r.note,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen
})

const COUNTER: Record<ConceptSignal, 'asked' | 'confused' | 'understood'> = {
  asked: 'asked',
  confused: 'confused',
  understood: 'understood'
}

/**
 * 记录一次信号。同一对话中同一概念的同类信号只计一次
 * （选区“解释”会立即记一次，对话结束后的整理可能再报告一次）。
 */
export function recordConcept(
  name: string,
  signal: ConceptSignal,
  evidence: { conversationId?: string; note?: string } = {},
  opts: { silent?: boolean } = {}
): Concept | null {
  const clean = name.trim().slice(0, 40)
  const norm = normConcept(clean)
  if (norm.length < 2) return null
  const db = profileDb()
  // 掌握度仍是全局信号，但仅限项目对话中的原文不能进入全局备注或证据。
  // 保留对话 ID 供同类信号去重，不保存可能复述项目内容的 note。
  const publicEvidence =
    evidence.conversationId && memoryProjectId(evidence.conversationId) ? { conversationId: evidence.conversationId } : evidence
  const now = Date.now()
  let row = db.prepare('SELECT * FROM concepts WHERE norm = ?').get(norm) as Row | undefined
  if (row && evidence.conversationId) {
    const dup = db
      .prepare('SELECT 1 FROM concept_events WHERE concept_id = ? AND type = ? AND evidence LIKE ?')
      .get(row.id, signal, `%"conversationId":"${evidence.conversationId}"%`)
    if (dup) return toConcept(row)
  }
  db.transaction(() => {
    if (!row) {
      const id = newId()
      db.prepare('INSERT INTO concepts (id, name, norm, mastery, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        clean,
        norm,
        MASTERY_START,
        now,
        now
      )
      row = db.prepare('SELECT * FROM concepts WHERE id = ?').get(id) as Row
    }
    const col = COUNTER[signal]
    db.prepare(`UPDATE concepts SET mastery = ?, ${col} = ${col} + 1, note = COALESCE(?, note), last_seen = ? WHERE id = ?`).run(
      nextMastery(row.mastery, signal),
      signal === 'understood' ? null : 'note' in publicEvidence ? (publicEvidence.note?.slice(0, 200) ?? null) : null,
      now,
      row.id
    )
    db.prepare('INSERT INTO concept_events (id, concept_id, type, at, evidence) VALUES (?, ?, ?, ?, ?)').run(
      newId(),
      row.id,
      signal,
      now,
      JSON.stringify(publicEvidence)
    )
  })()
  if (!opts.silent) emit('memory:changed', {})
  return toConcept(db.prepare('SELECT * FROM concepts WHERE id = ?').get(row!.id) as Row)
}

export function listConcepts(): Concept[] {
  return (profileDb().prepare('SELECT * FROM concepts ORDER BY last_seen DESC LIMIT 1000').all() as Row[]).map(toConcept)
}

export function removeConcept(id: string): void {
  const db = profileDb()
  db.transaction(() => {
    db.prepare('DELETE FROM concept_events WHERE concept_id = ?').run(id)
    db.prepare('DELETE FROM concepts WHERE id = ?').run(id)
  })()
  emit('memory:changed', {})
}

/** 用户校正掌握程度（“这个我已经懂了”） */
export function setConceptLevel(id: string, level: Concept['level']): void {
  profileDb().prepare('UPDATE concepts SET mastery = ?, last_seen = ? WHERE id = ?').run(LEVEL_MASTERY[level], Date.now(), id)
  emit('memory:changed', {})
}

/** 文本中出现的已知概念（最多 limit 个，较薄弱的优先） */
export function conceptsIn(text: string, limit = 5): Concept[] {
  const t = normConcept(text)
  if (t.length < 2) return []
  const rows = profileDb().prepare('SELECT * FROM concepts ORDER BY last_seen DESC LIMIT 2000').all() as Row[]
  return rows
    .filter((r) => r.norm.length >= 2 && t.includes(r.norm))
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, limit)
    .map(toConcept)
}

const LEVEL_LABEL: Record<Concept['level'], [string, string]> = {
  weak: ['薄弱', 'weak'],
  learning: ['学习中', 'learning'],
  solid: ['牢固', 'solid']
}

export function describeConcept(c: Concept, zh: boolean): string {
  const counts = zh
    ? [c.asked && `请求解释 ${c.asked} 次`, c.confused && `没弄懂 ${c.confused} 次`, c.understood && `表现出理解 ${c.understood} 次`]
    : [c.asked && `asked ${c.asked}×`, c.confused && `confused ${c.confused}×`, c.understood && `understood ${c.understood}×`]
  const parts = [LEVEL_LABEL[c.level][zh ? 0 : 1], ...counts.filter(Boolean)]
  if (c.note && c.level !== 'solid') parts.push(`${zh ? '卡点' : 'stuck on'}：${c.note}`)
  return `${c.name}（${parts.join(zh ? '；' : '; ')}）`
}

/** 本轮问题涉及的已知概念的掌握情况（放在本轮上下文里，不进系统提示，不影响缓存） */
export function learnerNote(text: string, zh: boolean): string | null {
  const list = conceptsIn(text)
  if (!list.length) return null
  return `${zh ? '用户对相关概念的掌握情况（据此调整讲解深浅，不要复述）' : "The user's grasp of related concepts (adjust depth; do not recite)"}：\n${list
    .map((c) => `- ${describeConcept(c, zh)}`)
    .join('\n')}`
}
