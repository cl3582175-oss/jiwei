import type { ContextPacket } from './context'
import type { BrowserTab } from './types'

export type ContextTab = Pick<BrowserTab, 'id' | 'url' | 'incognito' | 'sensitive'>
export type SelectedTab = Pick<ContextTab, 'id' | 'url'>
export type SavedTab = SelectedTab & { sourceId: string }

export const contextTabAllowed = (tab: ContextTab): boolean => !tab.incognito && !tab.sensitive && /^https?:\/\//i.test(tab.url)

export function sameContextTab(selected: SelectedTab, tabs: readonly ContextTab[]): boolean {
  const tab = tabs.find((item) => item.id === selected.id)
  return !!tab && contextTabAllowed(tab) && tab.url === selected.url
}

/** 每次发送重新读取主进程状态；网址绑定避免勾选之后跳到账号页时误收集新页面。 */
export async function collectTabSources(
  selected: readonly SelectedTab[],
  readTabs: () => Promise<readonly ContextTab[]>,
  saveSource: (tabId: string) => Promise<string>
): Promise<{ sources: SavedTab[]; unavailable: string[] }> {
  const pending = selected.filter((tab, index) => selected.findIndex((other) => other.id === tab.id) === index).slice(0, 8)
  const saved: SavedTab[] = []
  const unavailable = new Set<string>()
  for (const tab of pending) {
    if (!sameContextTab(tab, await readTabs())) {
      unavailable.add(tab.id)
      continue
    }
    try {
      const sourceId = await saveSource(tab.id)
      if (sameContextTab(tab, await readTabs())) saved.push({ ...tab, sourceId })
      else unavailable.add(tab.id)
    } catch (error) {
      if (sameContextTab(tab, await readTabs())) throw error
      unavailable.add(tab.id)
    }
  }
  // 后面的标签页保存可能耗时；在返回待发送的资料前也复核先前已保存的标签页。
  const current = await readTabs()
  const sources = saved.filter((tab) => {
    if (sameContextTab(tab, current)) return true
    unavailable.add(tab.id)
    return false
  })
  return { sources, unavailable: [...unavailable] }
}

/** 复用 viewport 锚点；每份网页保留自己的资料 ID，让回答引用落回正确网页。 */
export function withTabSources(packet: ContextPacket, tabs: readonly SavedTab[]): ContextPacket {
  const targets = [...packet.targets]
  if (packet.viewport && !targets.some((a) => a.parentType === packet.viewport?.parentType && a.parentId === packet.viewport.parentId))
    targets.push(packet.viewport)
  for (const tab of tabs) {
    if (targets.length >= 8) break
    if (!targets.some((a) => a.parentType === 'source' && a.parentId === tab.sourceId))
      targets.push({ kind: 'viewport', parentType: 'source', parentId: tab.sourceId })
  }
  return { ...packet, targets }
}
