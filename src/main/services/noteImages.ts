import { and, eq, isNull } from 'drizzle-orm'
import { nativeImage } from 'electron'
import { getDb } from '../db'
import { assets, assetTexts, jobs, noteAssetBlocks, notes } from '../db/schema'
import { assetPath } from './assets'
import { enqueue, registerJobKind } from './jobs'
import { localRecognizerInstalled, recognizeRegionDetailed, recognitionSettings } from './recognize'
import { requestIndex } from './ai/indexer'
import { emit } from '../events'
import { loadDoc, stateToJSON } from './docs'
import { deriveDoc } from '../lib/derive'
import type { RegionRecognition } from '@shared/types'

/** 同一资产可以出现在多个笔记，是否允许处理取当前有效引用；完成后再次检查。 */
export function liveImageReferences(assetId?: string, forIndex = true) {
  return getDb()
    .select({ ref: noteAssetBlocks, note: notes })
    .from(noteAssetBlocks)
    .innerJoin(notes, eq(notes.id, noteAssetBlocks.noteId))
    .where(
      and(
        isNull(notes.deletedAt),
        forIndex ? eq(notes.aiExcluded, false) : undefined,
        assetId ? eq(noteAssetBlocks.assetId, assetId) : undefined
      )
    )
    .all()
}

export function queueNoteImages(): void {
  if (!recognitionSettings().auto || recognitionSettings().mode === 'off' || !localRecognizerInstalled()) return
  for (const assetId of new Set(liveImageReferences().map((r) => r.ref.assetId))) {
    if (
      getDb()
        .select()
        .from(jobs)
        .where(and(eq(jobs.dedupeKey, `note.image:${assetId}`), eq(jobs.status, 'running')))
        .get()
    )
      continue
    if (!getDb().select().from(assetTexts).where(eq(assetTexts.assetId, assetId)).get())
      enqueue('note.image.recognize', { assetId }, { dedupeKey: `note.image:${assetId}` })
  }
}

async function recognizeAsset(assetId: string): Promise<RegionRecognition | null> {
  if (!/^[a-f0-9]{64}$/.test(assetId)) throw new Error('Invalid asset ID')
  const a = getDb().select().from(assets).where(eq(assets.id, assetId)).get()
  if (!a || !/^[a-z0-9]{1,10}$/.test(a.ext) || !a.mime?.startsWith('image/')) return null
  const img = nativeImage.createFromPath(assetPath(a.id, a.ext))
  if (img.isEmpty()) return null
  const size = img.getSize()
  const scaled = Math.max(size.width, size.height) > 2048 ? img.resize(size.width > size.height ? { width: 2048 } : { height: 2048 }) : img
  return recognizeRegionDetailed(scaled.toDataURL())
}

/** 用户明确选择一张仍存在于当前笔记的图片；仅用本地识别，不向云端发图。 */
export async function recognizeNoteFormula(noteId: string, imageId: string): Promise<RegionRecognition | null> {
  const currentImage = () => {
    const image = deriveDoc(stateToJSON(loadDoc(noteId))).assetImages.find((r) => r.imageId === imageId)
    if (!image) return null
    return liveImageReferences(image.assetId, false).some((r) => r.ref.noteId === noteId && r.ref.blockId === image.blockId) ? image : null
  }
  const image = currentImage()
  if (!image) return null
  const result = await recognizeAsset(image.assetId)
  // 同一容器可有多张图；完成后重新读正文，图片被删除或替换时不能插入旧资产的识别结果。
  return currentImage()?.assetId === image.assetId ? result : null
}

export function registerNoteImageJob(): void {
  registerJobKind<{ assetId: string }>('note.image.recognize', {
    title: () => 'captureContent.imageJob',
    async run({ assetId }) {
      if (!liveImageReferences(assetId).length) return { skipped: true }
      const result = await recognizeAsset(assetId)
      const refs = liveImageReferences(assetId)
      if (!result || !refs.length) return { skipped: true }
      getDb()
        .insert(assetTexts)
        .values({ assetId, text: result.text, engine: result.engine, updatedAt: Date.now() })
        .onConflictDoUpdate({ target: assetTexts.assetId, set: { text: result.text, engine: result.engine, updatedAt: Date.now() } })
        .run()
      requestIndex()
      emit('notes:changed', { ids: [...new Set(refs.map((r) => r.ref.noteId))] })
      return { recognized: true }
    }
  })
}
