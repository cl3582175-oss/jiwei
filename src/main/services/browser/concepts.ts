import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { ConceptDescribeSchema, ConceptPageSchema, conceptExcerpt } from '@shared/browserConcepts'
import { getSqlite } from '../../db'
import { describeConcept, listConcepts } from '../learner'
import { getSettings } from '../settings'
import * as m from './manager'

/** 主动提示只在允许的主文档中运行，网页子框架不能借此读取学习档案或笔记。 */
function eligible(tabId: string): boolean {
  const tab = m.getTab(tabId)
  return (
    !!tab &&
    !tab.incognito &&
    !m.isSensitive(tabId) &&
    !tab.view.webContents.isDestroyed() &&
    /^https?:\/\//i.test(tab.view.webContents.getURL()) &&
    (getSettings().browser?.proactivity ?? 'balanced') !== 'quiet'
  )
}

function senderTab(event: IpcMainEvent | IpcMainInvokeEvent, url: string): string | null {
  const tab = m.tabOf(event.sender)
  if (!tab || event.senderFrame !== event.sender.mainFrame || !eligible(tab.id)) return null
  return event.sender.getURL() === url && event.senderFrame.url === url ? tab.id : null
}

const weakConcepts = () =>
  listConcepts()
    .filter((concept) => concept.level === 'weak')
    .slice(0, 50)

export function clearConcepts(tabId: string): void {
  m.toPage(tabId, 'jw-page:concepts', { url: m.getTab(tabId)?.view.webContents.getURL() ?? '', names: [] })
}

/** 页面加载、档案或设置变化后推送；权限收紧时也必须推送空集合，移除旧的正文索引和提示。 */
export function pushConcepts(tabId: string): void {
  if (!eligible(tabId)) return clearConcepts(tabId)
  const tab = m.getTab(tabId)!
  m.toPage(tabId, 'jw-page:concepts', { url: tab.view.webContents.getURL(), names: weakConcepts().map((concept) => concept.name) })
}

export function refreshConcepts(): void {
  for (const tab of m.browserState().tabs) pushConcepts(tab.id)
}

export function registerConceptIpc(): void {
  ipcMain.on('jw-page:concepts-ready', (event, raw: unknown) => {
    const parsed = ConceptPageSchema.safeParse(raw)
    if (!parsed.success) return
    const tabId = senderTab(event, parsed.data.url)
    if (tabId) pushConcepts(tabId)
  })
  ipcMain.handle('jw-page:describe-concept', (event, raw: unknown): { text: string } | null => {
    const parsed = ConceptDescribeSchema.safeParse(raw)
    if (!parsed.success || !senderTab(event, parsed.data.url)) return null
    const concept = weakConcepts().find((item) => item.name === parsed.data.name)
    if (!concept) return null
    // LIKE 参数必须转义，否则用户记录的百分号或下划线会变成任意笔记的读取通配符。
    const query = `%${concept.name.replace(/[\\%_]/g, '\\$&')}%`
    const rows = getSqlite()
      .prepare(
        `
      SELECT b.text FROM blocks b JOIN notes n ON n.id = b.note_id
      WHERE b.deleted_at IS NULL AND n.deleted_at IS NULL AND n.ai_excluded = 0
        AND b.section IN ('row', 'body', 'summary') AND b.text LIKE ? ESCAPE '\\'
      ORDER BY b.updated_at DESC LIMIT 20
    `
      )
      .all(query) as { text: string }[]
    const excerpt = rows.map((row) => conceptExcerpt(row.text, concept.name)).find((text) => text !== null)
    return { text: (excerpt ?? describeConcept(concept, getSettings().language.startsWith('zh'))).slice(0, 200) }
  })
}
