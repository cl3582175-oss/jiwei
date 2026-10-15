import { getSettings } from '../settings'
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb, getSqlite } from '../../db'
import { annotations, assetTexts, noteAssetBlocks, blocks, chunks, notes, sourceSegments, sources } from '../../db/schema'
import { hashText } from '../../lib/derive'
import { enqueue, registerJobKind } from '../jobs'
import { currentModelId, embed, isReady, setStatus } from './embedding'
import { embeddingText } from '../../lib/chunker'
import { isIndexableText } from '../../lib/indexableText'
import { EmbeddingDimensionError } from '../../lib/embeddingDimension'

// 知识库索引：笔记（康奈尔行 + 总结段落）与原始资料（分段）两类来源。
// - “不发送给 AI”的笔记与资料不进入索引（使用云端向量服务时也不会外发）
// - 内容哈希不变的分片不重复计算；切换向量模型后全部重建
// - 由后台任务执行，可中断续跑

interface DesiredChunk {
  ownerType: 'block' | 'segment' | 'annotation' | 'asset'
  ownerId: string
  parentType: 'note' | 'source'
  parentId: string
  title: string
  text: string
  hash: string
}

/** 当前应当被索引的全部分片 */
export function desiredChunks(): DesiredChunk[] {
  const db = getDb()
  const noteRows = db
    .select({ id: blocks.id, noteId: blocks.noteId, text: blocks.text, title: notes.title })
    .from(blocks)
    .innerJoin(notes, eq(blocks.noteId, notes.id))
    .where(
      and(
        isNull(blocks.deletedAt),
        isNull(notes.deletedAt),
        eq(notes.aiExcluded, false),
        or(eq(blocks.section, 'row'), eq(blocks.section, 'summary'))
      )
    )
    .all()
  const segRows = db
    .select({
      id: sourceSegments.id,
      sourceId: sourceSegments.sourceId,
      text: sourceSegments.text,
      heading: sourceSegments.heading,
      title: sources.title
    })
    .from(sourceSegments)
    .innerJoin(sources, eq(sourceSegments.sourceId, sources.id))
    .where(
      and(
        isNull(sources.deletedAt),
        or(
          eq(sources.aiExcluded, false),
          and(
            eq(sources.space, 'attachment'),
            sql`${getSettings().ai.embedding?.mode === 'local' ? 1 : 0}`,
            sql`EXISTS (SELECT 1 FROM conversation_attachments ca WHERE ca.source_id=${sources.id} AND (EXISTS (SELECT 1 FROM conversations c WHERE c.id=ca.conversation_id AND c.incognito=0 AND c.deleted_at IS NULL) OR EXISTS (SELECT 1 FROM decisions d WHERE d.id=ca.conversation_id AND d.deleted_at IS NULL) OR ca.conversation_id LIKE 'orphan:%'))`,
            sql`NOT EXISTS (SELECT 1 FROM conversation_attachments ca LEFT JOIN conversations c ON c.id=ca.conversation_id WHERE ca.source_id=${sources.id} AND (c.incognito=1 OR ca.conversation_id LIKE 'incognito-draft:%'))`
          )
        )
      )
    )
    .all()
  return [
    ...annotationChunks(),
    ...db
      .select({ ref: noteAssetBlocks, text: assetTexts.text, title: notes.title })
      .from(noteAssetBlocks)
      .innerJoin(assetTexts, eq(assetTexts.assetId, noteAssetBlocks.assetId))
      .innerJoin(notes, eq(notes.id, noteAssetBlocks.noteId))
      .where(and(isNull(notes.deletedAt), eq(notes.aiExcluded, false)))
      .all()
      .filter((r) => r.text.trim())
      .map((r) => ({
        ownerType: 'asset' as const,
        ownerId: r.ref.id,
        parentType: 'note' as const,
        parentId: r.ref.noteId,
        title: r.title,
        text: `［图片文字］${r.text}`,
        hash: hashText(r.title, r.text)
      })),
    ...noteRows
      .filter((r) => isIndexableText(r.text))
      .map((r) => ({
        ownerType: 'block' as const,
        ownerId: r.id,
        parentType: 'note' as const,
        parentId: r.noteId,
        title: r.title,
        text: r.text,
        hash: hashText(r.title, r.text)
      })),
    ...segRows
      .filter((r) => isIndexableText(r.text))
      .map((r) => ({
        ownerType: 'segment' as const,
        ownerId: r.id,
        parentType: 'source' as const,
        parentId: r.sourceId,
        title: r.title,
        text: r.heading ? `${r.heading}\n${r.text}` : r.text,
        hash: r.heading ? hashText(r.title, r.heading, r.text) : hashText(r.title, r.text)
      }))
  ]
}

/** 批注检索时的文字：评论 / 提问 + 原文 */
export function annotationText(motivation: string, body: string, quote?: string): string {
  const tag = motivation === 'questioning' ? '［存疑］' : '［批注］'
  return `${tag}${body}${quote ? `\n（原文：${quote.slice(0, 300)}）` : ''}`
}

/** 有评论或提问的批注（所在笔记 / 资料未删除、未设为不发送给 AI） */
function annotationChunks(): DesiredChunk[] {
  const db = getDb()
  const rows = db
    .select()
    .from(annotations)
    .where(and(isNull(annotations.deletedAt), isNotNull(annotations.body)))
    .all()
  if (!rows.length) return []
  const live = (type: 'note' | 'source') => {
    const t = type === 'note' ? notes : sources
    return new Map(
      db
        .select({ id: t.id, title: t.title })
        .from(t)
        .where(and(isNull(t.deletedAt), eq(t.aiExcluded, false)))
        .all()
        .map((r) => [r.id, r.title])
    )
  }
  const titles = { note: live('note'), source: live('source') }
  const out: DesiredChunk[] = []
  for (const r of rows) {
    const title = titles[r.targetType].get(r.targetId)
    if (title === undefined || !r.body?.trim()) continue
    const sel = JSON.parse(r.selector) as { quote?: string }
    const text = annotationText(r.motivation, r.body, sel.quote)
    out.push({
      ownerType: 'annotation',
      ownerId: r.id,
      parentType: r.targetType,
      parentId: r.targetId,
      title,
      text,
      hash: hashText(title, text)
    })
  }
  return out
}

function deleteChunks(rowids: number[]): void {
  if (!rowids.length) return
  const sqlite = getSqlite()
  const delVec = sqlite.prepare('DELETE FROM vec_chunks WHERE rowid = ?')
  sqlite.transaction(() => {
    for (const r of rowids) delVec.run(BigInt(r))
  })()
  for (let i = 0; i < rowids.length; i += 500)
    getDb()
      .delete(chunks)
      .where(inArray(chunks.rowid, rowids.slice(i, i + 500)))
      .run()
}

const BATCH = 32

/** sqlite-vec 接收 float32 小端字节 */
export function vecBuffer(v: number[]): Buffer {
  const f = new Float32Array(v)
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

/** 同步索引：删除过期分片、补齐新分片 */
export async function syncIndex(progress: (p: number) => void, canceled: () => boolean): Promise<{ added: number; removed: number }> {
  const model = currentModelId()
  const want = desiredChunks()
  const wantMap = new Map(want.map((c) => [`${c.ownerType}:${c.ownerId}`, c]))
  const have = getDb().select().from(chunks).all()
  const stale = have.filter((h) => {
    const w = wantMap.get(`${h.ownerType}:${h.ownerId}`)
    return !w || w.hash !== h.hash || h.model !== model
  })
  deleteChunks(stale.map((s) => s.rowid))
  const keep = new Set(have.filter((h) => !stale.includes(h)).map((h) => `${h.ownerType}:${h.ownerId}`))
  const todo = want.filter((c) => !keep.has(`${c.ownerType}:${c.ownerId}`))
  setStatus({ indexed: want.length - todo.length, total: want.length })
  if (!todo.length) return { added: 0, removed: stale.length }

  const sqlite = getSqlite()
  const insVec = sqlite.prepare('INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)')
  let done = 0
  const written: number[] = []
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      if (canceled()) break
      // 队列与云端向量调用之间可能发生删除/隐私切换，发送前重新核对当前派生状态。
      const current = new Map(desiredChunks().map((c) => [`${c.ownerType}:${c.ownerId}`, c.hash]))
      const batch = todo.slice(i, i + BATCH).filter((c) => current.get(`${c.ownerType}:${c.ownerId}`) === c.hash)
      if (!batch.length) continue
      const guard = (): void => {
        const live = new Map(desiredChunks().map((c) => [`${c.ownerType}:${c.ownerId}`, c.hash]))
        if (canceled() || currentModelId() !== model || batch.some((c) => live.get(`${c.ownerType}:${c.ownerId}`) !== c.hash))
          throw new Error('Index content permission changed')
      }
      const vecs = await embed(
        batch.map((c) => embeddingText(c.text)),
        'doc',
        batch.map((c) => c.title),
        guard
      )
      guard()
      sqlite.transaction(() => {
        batch.forEach((c, j) => {
          const row = getDb()
            .insert(chunks)
            .values({
              ownerType: c.ownerType,
              ownerId: c.ownerId,
              parentType: c.parentType,
              parentId: c.parentId,
              hash: c.hash,
              model,
              createdAt: Date.now()
            })
            .onConflictDoUpdate({ target: [chunks.ownerType, chunks.ownerId], set: { hash: c.hash, model, createdAt: Date.now() } })
            .returning({ rowid: chunks.rowid })
            .get()
          sqlite.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(row.rowid))
          insVec.run(BigInt(row.rowid), vecBuffer(vecs[j]))
          written.push(row.rowid)
        })
      })()
      done += batch.length
      progress(done / todo.length)
      setStatus({ indexed: want.length - todo.length + done, total: want.length })
    }
  } catch (error) {
    if (error instanceof EmbeddingDimensionError) {
      // 后续批次才暴露不兼容时，也回收本轮已写入的向量，避免报告半轮成功。
      deleteChunks(written)
      setStatus({ state: 'error', message: error.message, indexed: want.length - todo.length, total: want.length }, model)
    }
    throw error
  }
  if (done > 0) setStatus({ state: 'ready', message: null })
  return { added: done, removed: stale.length }
}

/** 请求同步索引（合并重复请求；向量模型就绪后才执行） */
export function requestIndex(): void {
  void isReady().then((ready) => {
    if (ready) enqueue('index.sync', {}, { dedupeKey: 'index.sync' })
  })
}

export function registerIndexJob(): void {
  registerJobKind('index.sync', {
    title: () => '更新知识库索引',
    async run(_p, ctx) {
      const r = await syncIndex(ctx.progress, ctx.isCanceled)
      log.info('[index] sync', r)
      return r
    }
  })
}

/** 索引统计（用于设置页显示） */
export function indexStats(): { indexed: number; total: number } {
  const total = desiredChunks().length
  const indexed = (getSqlite().prepare('SELECT COUNT(*) AS n FROM chunks WHERE model = ?').get(currentModelId()) as { n: number }).n
  return { indexed: Math.min(indexed, total), total }
}

export function clearIndex(): void {
  getSqlite().exec('DELETE FROM vec_chunks')
  getDb().delete(chunks).run()
}

/** 一份资料的检索准备情况（v0.7.6）：文字分段立即可按关键词检索；语义索引由本地向量模型在后台建立 */
export { sourceIndexStatus } from './sourceIndexStatus'
