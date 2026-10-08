import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb } from '../db'
import { blocks, links, noteAssets, noteDocs, noteRevisions, noteUpdates, notes } from '../db/schema'
import { newId } from '../lib/ids'
import { countWords, deriveDoc, diffBlocks, type EmbedsData } from '../lib/derive'
import { deviceId } from './device'
import { recordActivity } from './stats'
import { emit } from '../events'
import { DOC_FIELD, EMBEDS_FIELD, type DocJSON, type Revision, type RevisionInfo } from '@shared/types'

// 笔记正文的持久化：
//   写入：渲染进程推送 Yjs 增量 → 追加到 note_updates（崩溃安全）→ 定期压缩进 note_docs
//   派生：防抖后从 Yjs 状态生成 JSON → 段落块（含段落级时间戳）、纯文本、素材引用、链接
//   历史：内容变化且距上个版本超过 10 分钟时自动保存快照，并按时间稀疏化保留

const DERIVE_DELAY = 800
const COMPACT_THRESHOLD = 64
const REVISION_INTERVAL = 10 * 60_000

const timers = new Map<string, NodeJS.Timeout>()

function readState(noteId: string): Uint8Array {
  const db = getDb()
  const base = db.select({ state: noteDocs.state }).from(noteDocs).where(eq(noteDocs.noteId, noteId)).get()
  const ups = db
    .select({ u: noteUpdates.update })
    .from(noteUpdates)
    .where(eq(noteUpdates.noteId, noteId))
    .orderBy(asc(noteUpdates.seq))
    .all()
  const parts = [...(base ? [new Uint8Array(base.state)] : []), ...ups.map((r) => new Uint8Array(r.u))]
  if (parts.length === 0) return Y.encodeStateAsUpdate(new Y.Doc())
  return parts.length === 1 ? parts[0] : Y.mergeUpdates(parts)
}

/** 新笔记的初始文档：一行空的康奈尔行 + 空总结（节点自带永久 ID） */
export function initDoc(noteId: string): void {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment(DOC_FIELD)
  const el = (type: string, children: Y.XmlElement[] = [], withId = true): Y.XmlElement => {
    const e = new Y.XmlElement(type)
    if (withId) e.setAttribute('id', newId())
    if (children.length) e.insert(0, children)
    return e
  }
  const para = (): Y.XmlElement => el('paragraph')
  const row = el('cornellRow', [el('cornellCue', [para()], false), el('cornellBody', [para()], false)])
  frag.insert(0, [row, el('cornellSummary', [para()])])
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  getDb()
    .insert(noteDocs)
    .values({ noteId, state: Buffer.from(state), updatedAt: Date.now() })
    .run()
}

export function loadDoc(noteId: string): Uint8Array {
  return readState(noteId)
}

export function stateToJSON(state: Uint8Array): DocJSON {
  return stateToContent(state).doc
}

/** Yjs 状态 → 文档 JSON + 富内容块数据 */
export function stateToContent(state: Uint8Array): { doc: DocJSON; embeds: EmbedsData } {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  const doc = yDocToProsemirrorJSON(ydoc, DOC_FIELD) as DocJSON
  const embeds = ydoc.getMap(EMBEDS_FIELD).toJSON() as EmbedsData
  ydoc.destroy()
  return { doc, embeds }
}

export function pushUpdate(noteId: string, update: Uint8Array): void {
  const db = getDb()
  db.insert(noteUpdates)
    .values({ noteId, update: Buffer.from(update), createdAt: Date.now() })
    .run()
  const t = timers.get(noteId)
  if (t) clearTimeout(t)
  timers.set(
    noteId,
    setTimeout(() => {
      timers.delete(noteId)
      try {
        derive(noteId)
      } catch (e) {
        log.error('[docs] derive failed', noteId, e)
      }
    }, DERIVE_DELAY)
  )
}

/** 立即执行所有待派生任务（退出前调用） */
export function flushAll(): void {
  for (const [id, t] of timers) {
    clearTimeout(t)
    timers.delete(id)
    try {
      derive(id)
    } catch (e) {
      log.error('[docs] flush derive failed', id, e)
    }
  }
}

function compact(noteId: string, state: Uint8Array): void {
  const db = getDb()
  db.transaction((tx) => {
    const maxSeq = tx
      .select({ seq: noteUpdates.seq })
      .from(noteUpdates)
      .where(eq(noteUpdates.noteId, noteId))
      .orderBy(desc(noteUpdates.seq))
      .limit(1)
      .get()
    tx.insert(noteDocs)
      .values({ noteId, state: Buffer.from(state), updatedAt: Date.now() })
      .onConflictDoUpdate({ target: noteDocs.noteId, set: { state: Buffer.from(state), updatedAt: Date.now() } })
      .run()
    if (maxSeq)
      tx.delete(noteUpdates)
        .where(and(eq(noteUpdates.noteId, noteId), lt(noteUpdates.seq, maxSeq.seq + 1)))
        .run()
  })
}

export function derive(noteId: string): void {
  const db = getDb()
  const note = db.select().from(notes).where(eq(notes.id, noteId)).get()
  if (!note) return
  const state = readState(noteId)
  const { doc: json, embeds } = stateToContent(state)
  const d = deriveDoc(json, embeds)
  const now = Date.now()

  const pending = db.select({ seq: noteUpdates.seq }).from(noteUpdates).where(eq(noteUpdates.noteId, noteId)).all().length
  if (pending >= COMPACT_THRESHOLD) compact(noteId, state)

  const prev = db
    .select({ id: blocks.id, hash: blocks.hash, deletedAt: blocks.deletedAt })
    .from(blocks)
    .where(eq(blocks.noteId, noteId))
    .all()
  const diff = diffBlocks(prev, d.blocks)
  const aiWords = countWords(d.aiText)
  const textChanged = d.plainText !== note.plainText || aiWords !== note.aiWordCount

  db.transaction((tx) => {
    for (const b of diff.inserted) {
      tx.insert(blocks)
        .values({
          id: b.id,
          noteId,
          kind: b.kind,
          origin: b.origin,
          section: b.section,
          rowId: b.rowId,
          position: b.position,
          text: b.text,
          hash: b.hash,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoNothing()
        .run()
    }
    for (const b of [...diff.changed, ...diff.revived]) {
      tx.update(blocks)
        .set({
          kind: b.kind,
          origin: b.origin,
          section: b.section,
          rowId: b.rowId,
          position: b.position,
          text: b.text,
          hash: b.hash,
          updatedAt: now,
          deletedAt: null
        })
        .where(eq(blocks.id, b.id))
        .run()
    }
    for (const b of diff.moved) {
      tx.update(blocks).set({ position: b.position, rowId: b.rowId, section: b.section, origin: b.origin }).where(eq(blocks.id, b.id)).run()
    }
    if (diff.removedIds.length) tx.update(blocks).set({ deletedAt: now }).where(inArray(blocks.id, diff.removedIds)).run()

    for (const assetId of d.assetIds) tx.insert(noteAssets).values({ noteId, assetId, createdAt: now }).onConflictDoNothing().run()

    // 正文链接：整体替换由正文派生的链接
    tx.delete(links)
      .where(and(eq(links.fromType, 'note'), eq(links.fromId, noteId), eq(links.origin, 'doc')))
      .run()
    for (const l of d.links) {
      tx.insert(links)
        .values({
          id: newId(),
          fromType: 'note',
          fromId: noteId,
          fromBlockId: l.fromBlockId,
          toType: l.toType,
          toId: l.toId,
          origin: 'doc',
          createdAt: now,
          updatedAt: now,
          updatedBy: deviceId()
        })
        .run()
    }

    if (textChanged) {
      tx.update(notes)
        .set({
          plainText: d.plainText,
          wordCount: countWords(d.plainText),
          aiWordCount: aiWords,
          editedAt: now,
          updatedAt: now,
          updatedBy: deviceId()
        })
        .where(eq(notes.id, noteId))
        .run()
    }
  })

  if (textChanged) {
    recordActivity('note_edit')
    // 学习统计只计算用户亲手写的（含审阅过的 AI 内容）
    const delta = countWords(d.plainText) - aiWords - (note.wordCount - note.aiWordCount)
    if (delta > 0) recordActivity('words', delta)
    maybeAutoRevision(noteId, state, note.title, countWords(d.plainText))
  }
  emit('notes:changed', { ids: [noteId] })
}

function maybeAutoRevision(noteId: string, state: Uint8Array, title: string, wordCount: number): void {
  const last = getDb()
    .select({ createdAt: noteRevisions.createdAt })
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, noteId))
    .orderBy(desc(noteRevisions.createdAt))
    .limit(1)
    .get()
  if (!last || Date.now() - last.createdAt >= REVISION_INTERVAL) saveRevision(noteId, 'auto', state, title, wordCount)
}

export function saveRevision(
  noteId: string,
  reason: RevisionInfo['reason'],
  state?: Uint8Array,
  title?: string,
  wordCount?: number
): RevisionInfo {
  const db = getDb()
  const note = db.select().from(notes).where(eq(notes.id, noteId)).get()
  if (!note) throw new Error(`Note not found: ${noteId}`)
  const row = {
    id: newId(),
    noteId,
    title: title ?? note.title,
    state: Buffer.from(state ?? readState(noteId)),
    wordCount: wordCount ?? note.wordCount,
    reason,
    createdAt: Date.now()
  }
  db.insert(noteRevisions).values(row).run()
  const { state: _s, ...info } = row
  return info
}

export function listRevisions(noteId: string): RevisionInfo[] {
  return getDb()
    .select({
      id: noteRevisions.id,
      noteId: noteRevisions.noteId,
      title: noteRevisions.title,
      wordCount: noteRevisions.wordCount,
      reason: noteRevisions.reason,
      createdAt: noteRevisions.createdAt
    })
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, noteId))
    .orderBy(desc(noteRevisions.createdAt))
    .all()
}

export function getRevision(id: string): Revision | null {
  const r = getDb().select().from(noteRevisions).where(eq(noteRevisions.id, id)).get()
  if (!r) return null
  const { state, ...info } = r
  return { ...info, doc: stateToJSON(new Uint8Array(state)) }
}

/**
 * 版本稀疏化：24 小时内全部保留；7 天内每小时 1 个；90 天内每天 1 个；更早每周 1 个。
 * 手动版本与恢复前版本永久保留。
 */
export function pruneRevisions(): void {
  const db = getDb()
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  const now = Date.now()
  const rows = db
    .select({ id: noteRevisions.id, noteId: noteRevisions.noteId, reason: noteRevisions.reason, createdAt: noteRevisions.createdAt })
    .from(noteRevisions)
    .where(and(eq(noteRevisions.reason, 'auto'), lt(noteRevisions.createdAt, now - DAY)))
    .orderBy(desc(noteRevisions.createdAt))
    .all()
  const seen = new Set<string>()
  const drop: string[] = []
  for (const r of rows) {
    const age = now - r.createdAt
    const span = age < 7 * DAY ? HOUR : age < 90 * DAY ? DAY : 7 * DAY
    const key = `${r.noteId}:${span}:${Math.floor(r.createdAt / span)}`
    if (seen.has(key)) drop.push(r.id)
    else seen.add(key)
  }
  for (let i = 0; i < drop.length; i += 500)
    db.delete(noteRevisions)
      .where(inArray(noteRevisions.id, drop.slice(i, i + 500)))
      .run()
}

export function listBlocks(noteId: string) {
  return getDb()
    .select({
      id: blocks.id,
      noteId: blocks.noteId,
      kind: blocks.kind,
      section: blocks.section,
      rowId: blocks.rowId,
      text: blocks.text,
      origin: blocks.origin,
      createdAt: blocks.createdAt,
      updatedAt: blocks.updatedAt
    })
    .from(blocks)
    .where(and(eq(blocks.noteId, noteId), isNull(blocks.deletedAt)))
    .orderBy(asc(blocks.position))
    .all()
}

/** 永久删除笔记时清理正文相关数据 */
export function purgeDocData(noteId: string): void {
  const db = getDb()
  db.delete(noteDocs).where(eq(noteDocs.noteId, noteId)).run()
  db.delete(noteUpdates).where(eq(noteUpdates.noteId, noteId)).run()
  db.delete(noteRevisions).where(eq(noteRevisions.noteId, noteId)).run()
  db.delete(blocks).where(eq(blocks.noteId, noteId)).run()
  db.delete(noteAssets).where(eq(noteAssets.noteId, noteId)).run()
}
