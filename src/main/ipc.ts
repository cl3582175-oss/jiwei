import { BrowserWindow, ipcMain, shell } from 'electron'
import log from 'electron-log/main'
import { backupsDir } from './db'
import * as notes from './services/notes'
import * as docs from './services/docs'
import * as sources from './services/sources'
import * as categories from './services/categories'
import * as tags from './services/tags'
import * as trash from './services/trash'
import * as stats from './services/stats'
import * as backups from './services/backup'
import * as assets from './services/assets'
import * as appSvc from './services/app'
import { getSettings, setSettings } from './services/settings'
import { resolveFlush } from './lifecycle'
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
    info: () => appSvc.appInfo(),
    openDataDir: () => appSvc.openDataDir(),
    changeDataDir: ({ win }) => appSvc.changeDataDir(win),
    flushDone: () => resolveFlush()
  },
  backups: {
    list: () => backups.listBackups(),
    create: () => backups.backupNow(),
    reveal: async () => {
      await shell.openPath(backupsDir())
    }
  },
  settings: {
    get: () => getSettings(),
    set: (_, patch) => setSettings(patch)
  },
  categories: {
    list: (_, kind) => categories.listCategories(kind),
    create: (_, kind, name, parentId) => categories.createCategory(kind, name, parentId),
    update: (_, id, patch) => categories.updateCategory(id, patch),
    remove: (_, id) => categories.removeCategory(id)
  },
  tags: {
    list: () => tags.listTags(),
    ensure: (_, name) => tags.ensureTag(name),
    rename: (_, id, name) => tags.renameTag(id, name),
    remove: (_, id) => tags.removeTag(id),
    set: (_, type, id, tagIds) => tags.setTags(type, id, tagIds)
  },
  notes: {
    list: (_, q) => notes.listNotes(q),
    get: (_, id) => notes.getNote(id),
    create: (_, init) => notes.createNote(init),
    update: (_, id, patch) => notes.updateNote(id, patch),
    trash: (_, id) => notes.trashNote(id),
    loadDoc: (_, id) => docs.loadDoc(id),
    pushUpdate: (_, id, update) => docs.pushUpdate(id, update),
    blocks: (_, id) => docs.listBlocks(id)
  },
  revisions: {
    list: (_, noteId) => docs.listRevisions(noteId),
    get: (_, id) => docs.getRevision(id),
    create: (_, noteId, reason) => {
      docs.flushAll()
      return docs.saveRevision(noteId, reason ?? 'manual')
    }
  },
  assets: {
    importBytes: (_, name, mime, bytes) => assets.importBytes(name, mime, bytes)
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
      ipcMain.handle(`${ns}:${name}`, async (e, ...args) => {
        try {
          return await fn({ win: BrowserWindow.fromWebContents(e.sender) }, ...args)
        } catch (err) {
          log.error(`[ipc] ${ns}:${name} failed`, err)
          throw err
        }
      })
    }
  }
}
