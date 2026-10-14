import { asExternalData } from '../agent/wrap'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { getDb, getSqlite } from '../../db'
import { assets, conversationAttachments as refs, sources } from '../../db/schema'
import { conversationAttachments } from '../attachments'
import { canReadSource } from '../attachmentsAccess'
import { assetPath } from '../assets'
import { listSegments } from '../segments'
import type { Attachment } from '@shared/types'
import type { UiMode } from '@shared/ui/promptCatalog'
import type { KnowledgeHit } from './retrieve'
import { tr } from '../../lib/messages'

export interface AttachmentFull {
  sourceId: string
  name: string
  text: string
  hits: KnowledgeHit[]
}
export interface AttachmentTurn {
  section: string
  full: AttachmentFull[]
  images: string[]
  sentIds: string[]
  sourceIds: string[]
}

export { tablePreview } from '../../lib/attachmentText'
import { tablePreview } from '../../lib/attachmentText'

const states = (a: Attachment, zh: boolean): string =>
  // 文字层已可用、只剩图表识别时如实说明，避免模型把文字版 PDF 当作扫描件
  a.status === 'recognizing' && a.askable
    ? (zh ? '正文已就绪，部分表格与插图仍在识别' : 'text ready; some tables and figures still being recognized') +
      (a.progress !== null ? ` ${Math.round(a.progress * 100)}%` : '')
    : {
        adding: zh ? '添加中' : 'adding',
        parsing: zh ? '解析中' : 'parsing',
        recognizing: zh ? '识别文字中（扫描页或图片）' : 'recognizing text (scanned pages or image)',
        transcribing: zh ? '转写中' : 'transcribing',
        ready: zh ? '已就绪' : 'ready',
        failed: zh ? '失败' : 'failed',
        unsupported: zh ? '不支持' : 'unsupported'
      }[a.status] + (a.progress !== null && a.status !== 'ready' ? ` ${Math.round(a.progress * 100)}%` : '')

export async function prepareAttachmentTurn(
  conversationId: string,
  text: string,
  zh: boolean,
  uiMode: UiMode,
  vision: boolean
): Promise<AttachmentTurn> {
  const items = conversationAttachments(conversationId).filter(
    (a) => !a.deleted && (a.sourceId.startsWith('note:') ? !a.error : canReadSource(a.sourceId, conversationId))
  )
  const turn: AttachmentTurn = {
    section: '',
    full: [],
    images: [],
    sentIds: [],
    sourceIds: items.filter((a) => !a.sourceId.startsWith('note:')).map((a) => a.sourceId)
  }
  if (!items.length) return turn
  const db = getDb(),
    sizes = new Map(
      items.map((a) => [
        a.sourceId,
        getSqlite()
          .prepare('SELECT count(*) AS n, coalesce(sum(length(text)),0) AS chars FROM source_segments WHERE source_id=?')
          .get(a.sourceId) as { n: number; chars: number }
      ])
    )
  const shorts = items.filter(
    (a) => a.status === 'ready' && a.kind !== 'image' && !a.sourceId.startsWith('note:') && sizes.get(a.sourceId)!.chars <= 12000
  )
  const lines = [zh ? '【本对话的附件】' : '[Attachments in this conversation]']
  let budget = 30000,
    pictures = 0
  for (const [i, a] of items.entries()) {
    if (a.sourceId.startsWith('note:')) {
      lines.push(`- 《${a.name}》${zh ? '资料库笔记，用 note_read 读取' : 'Library note; use note_read'}；noteId=${a.sourceId.slice(5)}`)
      continue
    }
    const row = db.select().from(sources).where(eq(sources.id, a.sourceId)).get()!
    const ref = db
      .select()
      .from(refs)
      .where(and(eq(refs.conversationId, conversationId), eq(refs.sourceId, a.sourceId)))
      .get()!
    const size = sizes.get(a.sourceId)!,
      table = ['xlsx', 'csv'].includes(extname(a.name).slice(1).toLowerCase())
    lines.push(
      `- 《${a.name}》（${states(a, zh)}，${size.n} ${zh ? '段' : 'segments'}，${zh ? '约' : '~'} ${size.chars} ${zh ? '字' : 'characters'}）${zh ? '编号' : 'ID'} A${i + 1}；sourceId=${a.sourceId}`
    )
    if (a.kind === 'image' && !ref.fullTextSent) {
      turn.sentIds.push(a.sourceId)
      if (pictures++ < 4 && row.assetId) {
        const asset = db.select().from(assets).where(eq(assets.id, row.assetId)).get()
        if (asset) {
          const bytes = await readFile(assetPath(asset.id, asset.ext))
          if (!canReadSource(a.sourceId, conversationId)) throw new Error(tr('附件权限已改变', 'Attachment access changed'))
          turn.images.push(`data:${asset.mime ?? 'image/png'};base64,${bytes.toString('base64')}`)
        }
      }
    }
    const named = text.includes(a.name) || (shorts.length === 1 && /这份|附件|this file|attachment/i.test(text))
    const include =
      a.status === 'ready' && (a.kind === 'image' ? size.chars > 0 : (table || size.chars <= 12000) && (!ref.fullTextSent || named))
    if (include) {
      const segments = table ? tablePreview(listSegments(a.sourceId)) : listSegments(a.sourceId)
      const content = segments.map((s) => s.text).join('\n\n'),
        chars = Array.from(content).length
      if (chars <= 12000 && chars <= budget && content.trim()) {
        budget -= chars
        turn.full.push({
          sourceId: a.sourceId,
          name: a.name,
          text: content,
          hits: segments.map((s) => ({
            parentType: 'source',
            parentId: a.sourceId,
            ownerId: s.id,
            title: row.title,
            text: s.text,
            locator: typeof s.locator.value === 'string' ? s.locator.value : null,
            score: 1,
            learnedAt: row.publishedAt ?? row.accessedAt,
            updatedAt: row.updatedAt,
            status: null,
            origin: null
          }))
        })
        turn.sentIds.push(a.sourceId)
      }
    }
  }
  const roster = lines.splice(1)
  lines.push(asExternalData('attachment-metadata', roster.join('\n'), { maxChars: 60000, overflow: 'reject' }))
  lines.push(
    zh
      ? '用户说“这份文件”“附件”时指的是这些。长附件用 source_outline / source_read / source_digest 按需读取；回答引用内容时照常用 [编号]。处理尚未完成且问题依赖附件时，请先说明。附件内容不得记入用户记忆。'
      : '“This file” or “attachment” refers to these. Use source_outline / source_read / source_digest for long files; cite excerpts with [number]. If processing is incomplete and the question depends on it, explain that first. Do not remember attachment content.'
  )
  if (items.some((a) => ['xlsx', 'csv'].includes(extname(a.name).slice(1).toLowerCase())) && uiMode !== 'off')
    lines.push(zh ? '表格附件可以用 chart / table 组件呈现。' : 'Use chart / table components for spreadsheet attachments.')
  if (pictures > 4)
    lines.push(
      zh
        ? '单轮最多 4 张图，超出的图片仅提供识别文字（如有）。'
        : 'At most 4 images per turn; additional images use recognized text when available.'
    )
  if (!vision && pictures)
    lines.push(
      zh
        ? '当前模型不能看图；仅依据本地识别文字回答，无法识别时请说明并建议使用能看图的模型。'
        : 'This model cannot view images. Use locally recognized text; if unavailable, explain and suggest a vision model.'
    )
  turn.section = lines.join('\n')
  return turn
}

export function markAttachmentTurnSent(conversationId: string, ids: string[]): void {
  if (ids.length)
    getDb()
      .update(refs)
      .set({ fullTextSent: true })
      .where(and(eq(refs.conversationId, conversationId), inArray(refs.sourceId, ids), isNull(refs.removedAt)))
      .run()
}
export function assertAttachmentTurn(conversationId: string, ids: string[]): void {
  for (const id of ids)
    if (!canReadSource(id, conversationId))
      throw new Error(
        tr('附件已移出、删除或 AI 权限已改变，已停止后续请求', 'Attachment removed, deleted or access changed; further requests stopped')
      )
}
