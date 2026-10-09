import { readFile, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { app, dialog, type BrowserWindow } from 'electron'
import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber } from 'pdf-lib'
import { getDb } from '../db'
import { annotations, assets, notes, sources } from '../db/schema'
import { newId } from '../lib/ids'
import { emit } from '../events'
import { deviceId } from './device'
import { assetPath } from './assets'
import { requestIndex } from './ai/indexer'
import { getSettings } from './settings'
import type { Annotation, AnnotationInput, AnnotationPatch, AnnotationWithTarget } from '@shared/types'

// 批注（v0.5.3，设计见 docs/design/v0.5-knowledge-structure.md §4）：
// PDF、文字资料、转写稿、笔记共用一套批注层，存入 annotations（W3C Web Annotation 模型）。
// 有评论或提问的批注进入知识库检索；导出 PDF 时写成标准 PDF 批注。

type Row = typeof annotations.$inferSelect

const toAnnotation = (r: Row): Annotation => ({
  id: r.id,
  targetType: r.targetType,
  targetId: r.targetId,
  selector: JSON.parse(r.selector) as Annotation['selector'],
  motivation: r.motivation,
  body: r.body,
  color: (r.color as Annotation['color']) ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
})

type ChangeListener = (targetType: 'note' | 'source', targetId: string) => void
const listeners: ChangeListener[] = []
/** 主进程内的批注变化监听（如：内置浏览器更新网页上的高亮） */
export function onAnnotationsChange(fn: ChangeListener): void {
  listeners.push(fn)
}

const changed = (r: Pick<Row, 'targetType' | 'targetId'>, text: boolean): void => {
  emit('annotations:changed', { targetType: r.targetType, targetId: r.targetId })
  for (const fn of listeners) fn(r.targetType, r.targetId)
  // 评论与提问进入检索
  if (text) requestIndex()
}
const hasText = (r: Pick<Row, 'body'> | Pick<Annotation, 'body'>): boolean => !!r.body?.trim()

export function listAnnotations(targetType: 'note' | 'source', targetId: string): Annotation[] {
  return getDb()
    .select()
    .from(annotations)
    .where(and(eq(annotations.targetType, targetType), eq(annotations.targetId, targetId), isNull(annotations.deletedAt)))
    .orderBy(annotations.createdAt)
    .all()
    .map(toAnnotation)
}

export function getAnnotation(id: string): Annotation | null {
  const r = getDb().select().from(annotations).where(eq(annotations.id, id)).get()
  return r && !r.deletedAt ? toAnnotation(r) : null
}

export function createAnnotation(input: AnnotationInput): Annotation {
  const now = Date.now()
  const row: Row = {
    id: newId(),
    targetType: input.targetType,
    targetId: input.targetId,
    selector: JSON.stringify(input.selector),
    motivation: input.motivation,
    body: input.body?.trim() || null,
    color: input.color ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    updatedBy: deviceId()
  }
  getDb().insert(annotations).values(row).run()
  changed(row, hasText(row))
  return toAnnotation(row)
}

export function updateAnnotation(id: string, patch: AnnotationPatch): Annotation {
  const db = getDb()
  const prev = db.select().from(annotations).where(eq(annotations.id, id)).get()
  if (!prev) throw new Error('Annotation not found')
  const set: Partial<Row> = { updatedAt: Date.now(), updatedBy: deviceId() }
  if (patch.body !== undefined) set.body = patch.body?.trim() || null
  if (patch.color !== undefined) set.color = patch.color
  if (patch.motivation) set.motivation = patch.motivation
  if (patch.selector) set.selector = JSON.stringify(patch.selector)
  db.update(annotations).set(set).where(eq(annotations.id, id)).run()
  const next = db.select().from(annotations).where(eq(annotations.id, id)).get()!
  changed(next, hasText(prev) || hasText(next))
  return toAnnotation(next)
}

export function removeAnnotation(id: string, restore = false): void {
  const db = getDb()
  const r = db.select().from(annotations).where(eq(annotations.id, id)).get()
  if (!r) return
  db.update(annotations)
    .set({ deletedAt: restore ? null : Date.now(), updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(annotations.id, id))
    .run()
  changed(r, hasText(r))
}

const targetTitle = (type: 'note' | 'source', id: string): string | null => {
  const t =
    type === 'note'
      ? getDb().select({ title: notes.title, d: notes.deletedAt }).from(notes).where(eq(notes.id, id)).get()
      : getDb().select({ title: sources.title, d: sources.deletedAt }).from(sources).where(eq(sources.id, id)).get()
  return t && !t.d ? t.title : null
}

/** 某时刻之后新增的批注（所在笔记 / 资料已删除的不含） */
export function recentAnnotations(since: number, until = Date.now()): AnnotationWithTarget[] {
  const rows = getDb()
    .select()
    .from(annotations)
    .where(and(isNull(annotations.deletedAt), gte(annotations.createdAt, since)))
    .orderBy(desc(annotations.createdAt))
    .limit(500)
    .all()
    .filter((r) => r.createdAt <= until)
  const out: AnnotationWithTarget[] = []
  for (const r of rows) {
    const title = targetTitle(r.targetType, r.targetId)
    if (title !== null) out.push({ ...toAnnotation(r), targetTitle: title })
  }
  return out
}

/* ——— 导出带批注的 PDF ——— */

const RGB: Record<NonNullable<Annotation['color']>, [number, number, number]> = {
  yellow: [1, 0.86, 0.3],
  green: [0.55, 0.85, 0.55],
  blue: [0.55, 0.75, 1],
  pink: [1, 0.6, 0.75]
}

/** 把 PDF 资料的高亮与评论写成标准 PDF 批注（Highlight + Contents），返回新文件的字节 */
export async function annotatedPdfBytes(sourceId: string): Promise<Uint8Array> {
  const row = getDb()
    .select({ a: assets })
    .from(sources)
    .innerJoin(assets, eq(sources.assetId, assets.id))
    .where(eq(sources.id, sourceId))
    .get()
  if (!row || row.a.ext !== 'pdf') throw new Error('不是 PDF 资料')
  const pdf = await PDFDocument.load(await readFile(assetPath(row.a.id, row.a.ext)), { updateMetadata: false })
  const pages = pdf.getPages()
  const author = app.getName()
  for (const a of listAnnotations('source', sourceId)) {
    const sel = a.selector
    if (!sel.page || !sel.rects?.length) continue
    const page = pages[sel.page - 1]
    if (!page) continue
    // 页内相对矩形（左上为原点）→ PDF 坐标（左下为原点），以裁剪框为准（与 pdf.js 显示一致）
    const box = page.getCropBox()
    const quads: number[] = []
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const r of sel.rects) {
      const left = box.x + r.x * box.width
      const right = left + r.w * box.width
      const top = box.y + (1 - r.y) * box.height
      const bottom = top - r.h * box.height
      quads.push(left, top, right, top, left, bottom, right, bottom)
      x0 = Math.min(x0, left)
      x1 = Math.max(x1, right)
      y0 = Math.min(y0, bottom)
      y1 = Math.max(y1, top)
    }
    const color = RGB[a.color ?? 'yellow']
    const comment = [a.motivation === 'questioning' ? '［存疑］' : '', a.body ?? ''].join('').trim()
    const dict = pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [x0, y0, x1, y1],
      QuadPoints: quads,
      C: color,
      CA: PDFNumber.of(0.45),
      F: 4,
      T: PDFHexString.fromText(author),
      M: PDFString.fromDate(new Date(a.updatedAt)),
      NM: PDFString.of(a.id),
      ...(comment ? { Contents: PDFHexString.fromText(comment) } : {})
    })
    const ref = pdf.context.register(dict)
    const annots = page.node.lookup(PDFName.of('Annots'))
    if (annots && 'push' in annots) (annots as unknown as { push(r: unknown): void }).push(ref)
    else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]))
  }
  return pdf.save()
}

export async function exportAnnotatedPdf(sourceId: string, win: BrowserWindow | null): Promise<string | null> {
  const s = getDb().select({ title: sources.title, name: sources.originalName }).from(sources).where(eq(sources.id, sourceId)).get()
  if (!s) throw new Error('Source not found')
  // 按积微的界面语言（而非系统语言）命名
  const zh = getSettings().language.startsWith('zh')
  const base = (s.name ? basename(s.name, extname(s.name)) : s.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
  const defaultPath = join(app.getPath('documents'), `${base}${zh ? '（批注）' : ' (annotated)'}.pdf`)
  const testDir = !app.isPackaged ? process.env.JIWEI_EXPORT_DIR : undefined
  let file: string
  if (testDir) file = join(testDir, basename(defaultPath))
  else {
    const opts = { defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    file = r.filePath
  }
  await writeFile(file, await annotatedPdfBytes(sourceId))
  return file
}
