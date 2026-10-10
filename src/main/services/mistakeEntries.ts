import { nativeImage } from 'electron'
import { eq } from 'drizzle-orm'
import type { MistakeCreate, MistakeIngestion } from '@shared/mistakes'
import { canonicalUrl } from '@shared/browserUrl'
import { getDb } from '../db'
import { sources } from '../db/schema'
import { isSensitiveUrl } from '../lib/browserPolicy'
import { getSettings } from './settings'
import { mistakeText } from './mistakesMessages'
import * as inbox from './inbox'
import * as mistakes from './mistakes'
import * as browserCapture from './browser/capture'
import * as browser from './browser/manager'
import { importBytes } from './assets'

// 入口绑定来自主进程现有原件；renderer 不能伪造来源来绕过隐私检查。
export function registerMistakeEntryGuards(): void {
  mistakes.setMistakePrivacyGuard((record) => {
    const blocked = getSettings().browser?.aiBlockedSites ?? []
    const inId = /^jiwei:\/\/inbox\/([\w-]+)$/.exec(record.sourceRef ?? '')?.[1]
    if (inId) {
      const item = inbox.get(inId)
      if (!item || item.deletedAt || (item.assetId && record.assetId !== item.assetId)) throw new Error(mistakeText('missing'))
      if (item.origin.url && isSensitiveUrl(item.origin.url, blocked)) throw new Error(mistakeText('localOnly'))
      if (item.origin.recordingSourceId) {
        const source = getDb().select().from(sources).where(eq(sources.id, item.origin.recordingSourceId)).get()
        if (!source || source.deletedAt || source.aiExcluded) throw new Error(mistakeText('localOnly'))
      }
    }
    const sourceId = /^jiwei:\/\/source\/([\w-]+)$/.exec(record.sourceRef ?? '')?.[1]
    if (sourceId) {
      const source = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
      if (!source || source.deletedAt || source.aiExcluded || (source.url && isSensitiveUrl(source.url, blocked)))
        throw new Error(mistakeText('localOnly'))
      for (const tab of browser.browserState().tabs)
        if (source.url && canonicalUrl(tab.url) === canonicalUrl(source.url) && (tab.sensitive || tab.incognito))
          throw new Error(mistakeText('localOnly'))
    }
    if (/^https?:\/\//i.test(record.sourceRef ?? '') && isSensitiveUrl(record.sourceRef!, blocked))
      throw new Error(mistakeText('localOnly'))
    if (record.sourceKind !== 'manual' && !inId && !sourceId) throw new Error(mistakeText('missing'))
  })
}

export function createManual(input: MistakeCreate): MistakeIngestion {
  if (input.sourceKind !== 'manual') throw new Error(mistakeText('missing'))
  return mistakes.create(input)
}
export function fromInbox(id: string, sourceKind: 'inbox' | 'capture' = 'inbox'): MistakeIngestion {
  const item = inbox.get(id)
  if (!item || item.deletedAt) throw new Error(mistakeText('missing'))
  return mistakes.create({
    sourceKind,
    sourceRef: `jiwei://inbox/${id}`,
    assetId: item.assetId,
    text: (item.text || item.recognized).slice(0, 12000),
    requestId: item.id
  })
}
export async function fromBrowserCapture(id: string): Promise<MistakeIngestion> {
  const captured = browserCapture.prepare(id, false, true)
  const image = nativeImage.createFromDataURL(captured.image)
  if (image.isEmpty()) throw new Error(mistakeText('missing'))
  const asset = await importBytes('mistake.png', 'image/png', image.toPNG())
  browserCapture.prepare(id, false, true)
  const source = getDb().select().from(sources).where(eq(sources.id, captured.sourceId)).get()
  if (!source || source.deletedAt || source.aiExcluded) throw new Error(mistakeText('localOnly'))
  return mistakes.create({
    sourceKind: 'browser',
    sourceRef: `jiwei://source/${captured.sourceId}`,
    assetId: asset.id,
    text: captured.recognition?.text.slice(0, 12000) ?? '',
    requestId: id
  })
}
