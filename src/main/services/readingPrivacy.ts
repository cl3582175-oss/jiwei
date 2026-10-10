import { eq } from 'drizzle-orm'
import type { ReadingTarget } from '@shared/reading'
import { canonicalUrl } from '@shared/browserUrl'
import { getDb } from '../db'
import { sources } from '../db/schema'
import * as browser from './browser/manager'
import { getSettings } from './settings'
import { isSensitiveUrl } from '../lib/browserPolicy'

export function readingError(kind: 'privacy' | 'changed' | 'model' | 'pending' | 'unapplied'): string {
  const zh = getSettings().language.startsWith('zh')
  const messages = {
    privacy: ['敏感页面、无痕标签或仅本地资料不提供对照阅读。','Reading is unavailable on sensitive, incognito or local-only material.'],
    changed: ['页面、资料或阅读设置已改变，请重试。','The page, material or reading preferences changed. Please retry.'],
    model: ['请先设置对话模型。','Configure a chat model first.'],
    pending: ['这个词的提案仍在落地，请稍后重试。','This word is being saved. Please retry shortly.'],
    unapplied: ['生词提案尚未完整应用到笔记。','The vocabulary proposal has not been fully applied.']
  }
  return messages[kind][zh ? 0 : 1]
}
/** 捕获可信身份，发送、回退重试和结果发布前均重新读取权限。 */
export function readingAccess(target: ReadingTarget): { key: string; url: string | null; guard: () => void } {
  const identity = getDb()
  if (target.kind === 'browser') {
    const tab = browser.getTab(target.id)
    if (!tab || tab.incognito || browser.isSensitive(target.id) || tab.view.webContents.isDestroyed()) throw new Error(readingError('privacy'))
    const url = canonicalUrl(tab.view.webContents.getURL())
    if (!/^https?:\/\//i.test(url)) throw new Error(readingError('privacy'))
    const guard = (): void => {
      if (getDb() !== identity || browser.getTab(target.id) !== tab || tab.view.webContents.isDestroyed() || canonicalUrl(tab.view.webContents.getURL()) !== url)
        throw new Error(readingError('changed'))
      if (tab.incognito || browser.isSensitive(target.id)) throw new Error(readingError('privacy'))
    }
    return { key: `page:${url}`,url,guard }
  }
  const source = identity.select().from(sources).where(eq(sources.id,target.id)).get()
  if (!source || source.deletedAt || source.aiExcluded) throw new Error(readingError('privacy'))
  const url=source.url?canonicalUrl(source.url):null
  const privateUrl=(value:string|null):boolean=>!!value&&isSensitiveUrl(value,getSettings().browser?.aiBlockedSites??[])
  const privateSourceTab=():boolean=>browser.browserState().tabs.some((tab)=>tab.sourceId===target.id&&(tab.sensitive||tab.incognito))
  if(privateUrl(url)||privateSourceTab())throw new Error(readingError('privacy'))
  return {
    key:`source:${target.id}`,url,
    guard:():void => {
      if (getDb() !== identity) throw new Error(readingError('changed'))
      const current = identity.select().from(sources).where(eq(sources.id,target.id)).get()
      if (!current || current.deletedAt || current.aiExcluded || privateUrl(current.url) || privateSourceTab()) throw new Error(readingError('privacy'))
      if((current.url?canonicalUrl(current.url):null)!==url)throw new Error(readingError('changed'))
    }
  }
}
