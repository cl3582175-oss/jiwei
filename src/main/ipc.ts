import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { dataDir } from './db'
import * as notes from './services/notes'
import * as sources from './services/sources'
import * as categories from './services/categories'
import * as trash from './services/trash'
import * as stats from './services/stats'
import { getSettings, setSettings } from './services/settings'
import type { JiweiAPI } from '@shared/types'

type Handlers = {
  [NS in keyof JiweiAPI]: {
    [M in keyof JiweiAPI[NS]]: JiweiAPI[NS][M] extends (...a: infer A) => infer R
      ? (ctx: { win: BrowserWindow | null }, ...a: A) => R | Awaited<R>
      : never
  }
}

const handlers: Handlers = {
  app: {
    info: () => ({ version: app.getVersion(), dataDir: dataDir(), platform: process.platform }),
    openDataDir: async () => {
      await shell.openPath(dataDir())
    }
  },
  settings: {
    get: () => getSettings(),
    set: (_, patch) => setSettings(patch)
  },
  categories: {
    list: (_, kind) => categories.listCategories(kind),
    create: (_, kind, name) => categories.createCategory(kind, name),
    rename: (_, id, name) => categories.renameCategory(id, name),
    remove: (_, id) => categories.removeCategory(id)
  },
  notes: {
    list: (_, q) => notes.listNotes(q),
    get: (_, id) => notes.getNote(id),
    create: (_, init) => notes.createNote(init),
    update: (_, id, patch) => notes.updateNote(id, patch),
    trash: (_, id) => notes.trashNote(id)
  },
  sources: {
    list: (_, q) => sources.listSources(q),
    importDialog: ({ win }, categoryId) => sources.importDialog(win, categoryId),
    importPaths: (_, paths, categoryId) => sources.importPaths(paths, categoryId),
    addUrl: (_, url, title, categoryId) => sources.addUrl(url, title, categoryId),
    update: (_, id, patch) => sources.updateSource(id, patch),
    open: (_, id) => sources.openSource(id),
    reveal: (_, id) => sources.revealSource(id),
    trash: (_, id) => sources.trashSource(id)
  },
  trash: {
    list: () => trash.listTrash(),
    restore: (_, type, id) => trash.restore(type, id),
    purge: (_, type, id) => trash.purge(type, id),
    empty: () => trash.emptyTrash()
  },
  stats: {
    heatmap: (_, days) => stats.heatmap(days)
  }
}

export function registerIpc(): void {
  for (const [ns, methods] of Object.entries(handlers)) {
    for (const [name, fn] of Object.entries(methods as Record<string, (...a: unknown[]) => unknown>)) {
      ipcMain.handle(`${ns}:${name}`, (e, ...args) => fn({ win: BrowserWindow.fromWebContents(e.sender) }, ...args))
    }
  }
}
