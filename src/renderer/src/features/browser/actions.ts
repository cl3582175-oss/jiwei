import { useEffect } from 'react'
import i18n from 'i18next'
import { toast } from 'sonner'
import type { Anchor } from '@shared/context'
import type { BrowserAction } from '@shared/types'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useAssist, type Rect } from '../assist/store'
import { askInline } from '../assist/actions'
import { annotate, useAnnotate } from '../annotate/store'
import { errText } from '../chat/useChat'
import { useBrowser, wireBrowserEvents } from './store'

// 内置浏览器中网页选区浮条的操作（v0.6.0）：与资料中的浮条走同一套流程——
// 先把网页存为资料（同一网址复用），再就地提问 / 高亮 / 批注。卡片停靠在浏览器右侧（网页是原生视图，盖不住）。

/** 卡片位置：浏览器区域的右侧，与选区同高 */
function dockRect(a: BrowserAction): Rect {
  const slot = document.querySelector('[data-testid="browser-view"]')?.getBoundingClientRect()
  if (!slot) return { x: a.rect.x, y: a.rect.y, w: a.rect.w, h: a.rect.h }
  const y = slot.top + a.rect.y
  // 卡片以 rect 中心定位：把中心放到浏览器右缘之外
  return { x: slot.right + 222, y, w: 0, h: a.rect.h }
}

async function handle(a: BrowserAction): Promise<void> {
  let sourceId: string
  try {
    sourceId = await api.browser.saveSource(a.tabId)
  } catch (e) {
    toast.error(errText(e))
    return
  }
  const rect = dockRect(a)
  if (a.action === 'annotation') {
    if (a.annotationId) useAnnotate.getState().open({ id: a.annotationId, targetType: 'source', targetId: sourceId, rect, edit: false })
    return
  }
  const anchor: Anchor = {
    kind: 'source-text',
    parentType: 'source',
    parentId: sourceId,
    ownerId: null,
    quote: a.quote,
    ...(a.prefix ? { prefix: a.prefix } : {}),
    ...(a.suffix ? { suffix: a.suffix } : {})
  }
  useApp.getState().setContext({ sourceId, sourceSelection: a.quote, sourceSegmentId: null, sourceLocator: null })
  if (a.action === 'highlighting' || a.action === 'commenting' || a.action === 'questioning') {
    await annotate(anchor, a.action, rect)
    return
  }
  if (a.action === 'ask') useAssist.getState().openCard({ anchor, rect, action: 'ask', conversationId: null, question: '' })
  else await askInline(a.action, anchor, rect)
}

/** 应用级：订阅浏览器事件（标签页状态、网页操作、下载） */
export function useBrowserEvents(): void {
  useEffect(() => {
    wireBrowserEvents()
    const offs = [
      window.jiweiEvents.on('browser:action', (a) => void handle(a)),
      // 焦点在网页中时的快捷键：⌘W 关闭标签页，其余按普通快捷键处理
      window.jiweiEvents.on('browser:shortcut', ({ key, shift }) => {
        if (key === 'w') {
          document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"] button')?.click()
          return
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, metaKey: window.platform?.os === 'darwin', ctrlKey: window.platform?.os !== 'darwin', bubbles: true }))
      }),
      window.jiweiEvents.on('browser:download', (d) => {
        if (d.sourceId)
          toast.success(i18n.t('browser.imported', { name: d.name }), {
            action: { label: i18n.t('browser.openImported'), onClick: () => useApp.getState().openSource(d.sourceId) }
          })
        else
          toast(i18n.t('browser.downloaded', { name: d.name }), {
            action: { label: i18n.t('annotate.reveal'), onClick: () => void api.app.showInFolder(d.path) }
          })
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])
}

export { useBrowser }
