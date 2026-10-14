import * as Y from 'yjs'
import { asc, eq } from 'drizzle-orm'
import { getDb } from '../db'
import { noteDocs, noteUpdates } from '../db/schema'

/** 正文与主进程来源元数据共用同一份可合并、可备份的 Yjs 状态。 */
export function readNoteState(noteId: string): Uint8Array {
  const db = getDb()
  const base = db.select({ state: noteDocs.state }).from(noteDocs).where(eq(noteDocs.noteId, noteId)).get()
  const updates = db
    .select({ u: noteUpdates.update })
    .from(noteUpdates)
    .where(eq(noteUpdates.noteId, noteId))
    .orderBy(asc(noteUpdates.seq))
    .all()
  const parts = [...(base ? [new Uint8Array(base.state)] : []), ...updates.map((r) => new Uint8Array(r.u))]
  return parts.length === 0 ? Y.encodeStateAsUpdate(new Y.Doc()) : parts.length === 1 ? parts[0] : Y.mergeUpdates(parts)
}
