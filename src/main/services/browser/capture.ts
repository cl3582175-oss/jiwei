import { captureText } from '../capture/messages'
import * as Y from 'yjs'
import { DOC_FIELD } from '@shared/types'
import { loadDoc } from '../docs'
import { nativeImage, type NativeImage } from 'electron'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  captureIdentityValid,
  capturePixels,
  BrowserCaptureEntriesSchema,
  type BrowserCaptureFrame,
  type BrowserCaptureResult,
  type CaptureRect
} from '@shared/browserCapture'
import { newId } from '../../lib/ids'
import { isSensitiveUrl } from '../../lib/browserPolicy'
import { getDb } from '../../db'
import { sources } from '../../db/schema'
import { recognizeRegionDetailed } from '../recognize'
import { getSettings } from '../settings'
import { structured, quickModel } from '../ai/structured'
import { saveAnswer } from '../saveAnswer'
import { saveTab } from './pages'
import * as m from './manager'

interface Capture {
  frame: BrowserCaptureFrame
  image: NativeImage | null
  capturedAt: number
  result?: BrowserCaptureResult
  committed: boolean
}
const captures = new Map<string, Capture>()
type SaveReceipt = { noteId: string; created: boolean; proposalId: string }
const saves = new Map<string, SaveReceipt>()
const pendingSaves = new Map<string, Promise<SaveReceipt>>()
function fail(): never {
  throw new Error(captureText('pageChanged'))
}
function validate(c: Capture): void {
  const t = m.getTab()
  if (
    !captureIdentityValid(
      c.frame,
      t
        ? { tabId: t.id, scope: t.captureScope, url: t.view.webContents.getURL(), incognito: t.incognito, sensitive: m.isSensitive(t.id) }
        : null
    )
  )
    fail()
}
function get(id: string): Capture {
  const c = captures.get(id)
  if (!c) fail()
  return c
}
export async function begin(): Promise<BrowserCaptureFrame> {
  const t = m.getTab()
  if (!t) fail()
  const id = newId()
  const c: Capture = {
    frame: { id, tabId: t.id, scope: t.captureScope, url: t.view.webContents.getURL(), image: '' },
    image: null,
    capturedAt: Date.now(),
    committed: false
  }
  validate(c)
  if (captures.size >= 60) throw new Error(captureText('excerptLimit'))
  const retained = await m.beginCaptureFreeze(id)
  c.image = nativeImage.createFromBuffer(retained.toPNG({ scaleFactor: Math.max(...retained.getScaleFactors()) }))
  try {
    validate(c)
    c.frame.image = c.image.toDataURL()
    captures.set(id, c)
    return c.frame
  } catch (e) {
    await m.endCaptureFreeze(id)
    throw e
  }
}
export async function recognize(id: string, rect: CaptureRect): Promise<BrowserCaptureResult> {
  const c = get(id)
  try {
    validate(c)
    if (!c.image) fail()
    // NativeImage 的 size/crop 是 DIP；先取最大比例的位图，再按真实像素重建，保留 Retina 清晰度。
    const pixels = c.image
    const size = pixels.getSize()
    const crop = capturePixels(rect, size.width, size.height)
    const image = pixels.crop(crop).toDataURL()
    const recognition = await recognizeRegionDetailed(image)
    validate(c)
    const sourceId = await saveTab(c.frame.tabId)
    validate(c)
    const t = m.getTab(c.frame.tabId)!
    c.result = {
      ...c.frame,
      image,
      sourceId,
      title: t.view.webContents.getTitle(),
      capturedAt: c.capturedAt,
      recognition,
      anchor: { kind: 'region', parentType: 'source', parentId: sourceId, rect, quote: recognition?.text.slice(0, 8000) ?? '' }
    }
    c.image = null
    c.frame.image = ''
    return c.result
  } finally {
    await m.endCaptureFreeze(id)
  }
}
export async function release(id: string): Promise<void> {
  captures.delete(id)
  for (const key of saves.keys()) if (key.includes(id)) saves.delete(key)
  await m.endCaptureFreeze(id)
}
function sourceValid(c: Capture): void {
  if (!c.result) fail()
  const src = getDb().select().from(sources).where(eq(sources.id, c.result.sourceId)).get()
  if (!src || src.deletedAt || src.aiExcluded || isSensitiveUrl(c.frame.url, getSettings().browser?.aiBlockedSites ?? [])) fail()
  // 已加入面板的材料独立于之后的导航；同一页面仍需尊重最新隐私状态。
  const t = m.getTab(c.frame.tabId)
  if (t?.view.webContents.getURL() === c.frame.url && (t.incognito || m.isSensitive(t.id))) fail()
}
export function prepare(id: string, commit = false, requireCurrent = false): BrowserCaptureResult {
  const c = get(id)
  if (!c.committed || commit || requireCurrent) validate(c)
  sourceValid(c)
  if (commit) c.committed = true
  return c.result!
}
/** 合并双击与超时重试，目标笔记和输入文字在点击时固定。 */
export async function save(entries: z.infer<typeof BrowserCaptureEntriesSchema>, noteId: string | null): Promise<SaveReceipt> {
  const list = BrowserCaptureEntriesSchema.parse(entries)
  const key = JSON.stringify(list)
  const pending = pendingSaves.get(key)
  if (pending) return pending
  const task = saveEntries(list, noteId)
  pendingSaves.set(key, task)
  try {
    return await task
  } finally {
    if (pendingSaves.get(key) === task) pendingSaves.delete(key)
  }
}
async function saveEntries(
  entries: z.infer<typeof BrowserCaptureEntriesSchema>,
  noteId: string | null
): Promise<{ noteId: string; created: boolean; proposalId: string }> {
  const list = BrowserCaptureEntriesSchema.parse(entries)
  const results = list.map((e) => prepare(e.id))
  const key = JSON.stringify(list)
  const existing = saves.get(key)
  if (existing) return existing
  const answer = list
    .map(
      (e, i) =>
        `${e.text}\n\n[${results[i].title.replace(/[[\]\\]/g, '')}](jiwei://source/${results[i].sourceId}) · ${results[i].url} · ${new Date(results[i].capturedAt).toISOString()}`
    )
    .join('\n\n---\n\n')
  if (answer.length > 20000) throw new Error(captureText('excerptTooLong'))
  const s = getSettings()
  let cue = ''
  if (s.ai.chat.providerId && s.ai.chat.model) {
    const result = await structured({
      providerId: s.ai.chat.providerId,
      model: quickModel(s.ai.chat.providerId, s.ai.chat.model),
      system: s.language.startsWith('zh')
        ? '只根据摘抄生成一句简短的复习问题作为线索。'
        : 'Generate one short review question based only on these excerpts.',
      prompt: list.map((e) => e.text).join('\n\n'),
      schema: z.object({ cue: z.string().max(500) })
    })
    cue = result.cue
  }
  list.forEach((e) => prepare(e.id))
  // 复用既有自动应用提案路径；同步落库成功后才让渲染器清空条目。
  const result = saveAnswer({ noteId, sourceId: results[0].sourceId, cue, answer, anchor: results[0].anchor })
  saves.set(key, result)
  return result
}

/** 自动提案在渲染器应用后才算保存；以落盘 Yjs 行的提案标记确认，不以 IPC 成功替代。 */
export function saved(proposalId: string): boolean {
  const receipt = [...saves.values()].find((r) => r.proposalId === proposalId)
  if (!receipt) return false
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, loadDoc(receipt.noteId))
    return doc
      .getXmlFragment(DOC_FIELD)
      .toArray()
      .some((node) => {
        if (!(node instanceof Y.XmlElement)) return false
        try {
          return (JSON.parse(node.getAttribute('origin') ?? '{}') as { proposalId?: string }).proposalId === proposalId
        } catch {
          return false
        }
      })
  } finally {
    doc.destroy()
  }
}
