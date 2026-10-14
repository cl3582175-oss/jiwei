import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { assets, notes, sources, blocks as noteBlocks } from '../../db/schema'
import { attachmentStatus } from '../attachments'
import { canReadSource } from '../attachmentsAccess'
import { assetPath } from '../assets'
import { listSegments } from '../segments'
import { recognizeRegion } from '../recognize'
import { asExternalData } from '../agent/wrap'
import { tablePreview } from '../../lib/attachmentText'
import type { MemoSource } from '@shared/advisor'

export async function advisorAttachmentInput(ids: string[], decisionId: string, vision: boolean, zh: boolean) {
  const blocks: string[] = [],
    images: { data: Uint8Array; mediaType: string }[] = [],
    refs: MemoSource[] = []
  for (const id of ids) {
    const a = attachmentStatus([id])[0]
    if (!a || a.deleted) throw new Error('Attachment unavailable')
    if (id.startsWith('note:')) {
      const n = getDb()
        .select()
        .from(notes)
        .where(eq(notes.id, id.slice(5)))
        .get()
      if (!n || n.deletedAt || n.aiExcluded) throw new Error('Note excluded from AI')
      blocks.push(
        asExternalData(
          'attachment:' + a.name,
          n.plainText.slice(0, 12000) +
            (n.plainText.length > 12000 ? (zh ? '\n（已截断为前12000字）' : '\n(Truncated to 12,000 characters)') : ''),
          { maxChars: 16000, overflow: 'reject' }
        )
      )
      for (const b of getDb()
        .select()
        .from(noteBlocks)
        .where(eq(noteBlocks.noteId, n.id))
        .all()
        .filter((b) => b.deletedAt === null))
        refs.push({ id: '', parentType: 'note', parentId: n.id, ownerId: b.id, title: a.name, text: b.text.slice(0, 700), locator: null })
      continue
    }
    if (!canReadSource(id, decisionId)) throw new Error('Source access revoked')
    const segments = tablePreview(listSegments(id)),
      full = segments.map((s) => s.text).join('\n'),
      text = Array.from(full).slice(0, 12000).join('')
    if (a.kind === 'image') {
      const s = getDb().select().from(sources).where(eq(sources.id, id)).get()!,
        asset = s.assetId ? getDb().select().from(assets).where(eq(assets.id, s.assetId)).get() : null
      if (asset) {
        const data = await readFile(assetPath(asset.id, asset.ext ?? 'png'))
        if (vision && images.length < 4) images.push({ data, mediaType: a.mime ?? 'image/png' })
        else if (!text)
          blocks.push(
            asExternalData(
              'attachment:' + a.name,
              (await recognizeRegion(`data:${a.mime ?? 'image/png'};base64,${data.toString('base64')}`)) ?? ''
            )
          )
      }
    }
    blocks.push(
      asExternalData(
        'attachment:' + a.name,
        text +
          (Array.from(full).length > 12000 ? (zh ? '\n（已截断为前12000字）' : '\n(Truncated to 12,000 characters)') : '') +
          (!text && a.kind !== 'image' ? `\n${zh ? '附件状态' : 'Attachment status'}: ${a.status}` : ''),
        { maxChars: 20000, overflow: 'reject' }
      )
    )
    let remaining = 12000
    for (const seg of segments) {
      if (remaining <= 0) break
      refs.push({
        id: '',
        parentType: 'source',
        parentId: id,
        ownerId: seg.id,
        title: a.name,
        text: Array.from(seg.text).slice(0, Math.min(remaining, 700)).join(''),
        locator: typeof seg.locator.value === 'string' ? seg.locator.value : null
      })
      remaining -= Array.from(seg.text).length + 1
    }
  }
  return { blocks, images, refs }
}
