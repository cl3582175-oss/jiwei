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
import * as proposals from './services/proposals'
import * as segments from './services/segments'
import * as jobs from './services/jobs'
import * as vaults from './services/vaults'
import { getProfile, setProfileName } from './services/device'
import { resolveFlush } from './lifecycle'
import * as providers from './services/ai/providers'
import * as chat from './services/ai/chat'
import * as embedding from './services/ai/embedding'
import { clearIndex, indexStats, requestIndex } from './services/ai/indexer'
import { retrieve } from './services/ai/retrieve'
import * as memory from './services/memory'
import * as learner from './services/learner'
import * as memoryLearn from './services/memoryLearn'
import * as review from './services/review'
import * as feynman from './services/feynman'
import * as reflection from './services/reflection'
import * as progress from './services/progress'
import * as connections from './services/connections'
import { knowledgeGraph } from './services/graph'
import * as asr from './services/asr'
import * as recognize from './services/recognize'
import { saveAnswer } from './services/saveAnswer'
import { exportNote } from './services/exportNote'
import { registerSandbox } from './services/sandbox'
import * as skills from './services/ai/skills'

/** 会影响知识库内容（或隐私范围）的操作完成后，更新索引 */
const reindexAfter = <T>(v: T): T => {
  requestIndex()
  return v
}
import { capabilities, eachCapability, parseArgs, type Capabilities, type ParsedArgs, type ResultOf } from '@shared/capabilities'

type Ctx = { win: BrowserWindow | null }

/** 每个注册的能力都必须有实现；参数类型为 zod 解析后的类型 */
type Handlers = {
  [NS in keyof Capabilities]: {
    [M in keyof Capabilities[NS]]: (
      ctx: Ctx,
      ...args: ParsedArgs<Capabilities[NS][M]>
    ) => ResultOf<Capabilities[NS][M]> | Promise<ResultOf<Capabilities[NS][M]>>
  }
}

const handlers: Handlers = {
  app: {
    showInFolder: (_, path) => shell.showItemInFolder(path),
    info: () => appSvc.appInfo(),
    openDataDir: () => appSvc.openDataDir(),
    changeDataDir: ({ win }) => appSvc.changeDataDir(win),
    flushDone: () => resolveFlush()
  },
  vaults: {
    list: () => vaults.listVaults(),
    create: ({ win }, name) => vaults.createVault(win, name),
    open: ({ win }) => vaults.openVault(win),
    switch: (_, id) => vaults.switchVault(id),
    rename: (_, id, name) => vaults.renameVault(id, name)
  },
  profile: {
    get: () => getProfile(),
    setName: (_, name) => setProfileName(name)
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
    set: (_, patch) => {
      const before = JSON.stringify(getSettings().ai.recognition ?? null)
      const r = setSettings(patch)
      // 换了识别引擎或开启插图解读：有待识别页的资料按新设置排队
      if (patch.ai && JSON.stringify(patch.ai.recognition ?? null) !== before) recognize.queuePending()
      return r
    }
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
    export: ({ win }, id, format, images) => exportNote(win, id, format, images),
    createSample: (_, lang) => notes.createSampleNote(lang),
    update: (_, id, patch) =>
      patch.aiExcluded !== undefined || patch.status !== undefined
        ? reindexAfter(notes.updateNote(id, patch))
        : notes.updateNote(id, patch),
    trash: (_, id) => reindexAfter(notes.trashNote(id)),
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
  proposals: {
    create: (_, input) => proposals.createProposal(input),
    list: (_, noteId) => proposals.listProposals(noteId),
    resolve: (_, id, opIndex, decision, blockIds) => proposals.resolveOp(id, opIndex, decision, blockIds)
  },
  segments: {
    update: (_, id, text) => reindexAfter(segments.updateSegmentText(id, text)),
    list: (_, sourceId) => segments.listSegments(sourceId),
    search: (_, query, sourceId) => segments.searchSegments(query, sourceId)
  },
  jobs: {
    list: () => jobs.listJobs(),
    cancel: (_, id) => jobs.cancelJob(id),
    retry: (_, id) => jobs.retryJob(id)
  },
  sandbox: {
    register: (_, html) => registerSandbox(html)
  },
  assets: {
    importBytes: (_, name, mime, bytes) => assets.importBytes(name, mime, bytes)
  },
  sources: {
    list: (_, q) => sources.listSources(q),
    get: (_, id) => sources.getSource(id),
    importDialog: ({ win }, categoryId) => sources.importDialog(win, categoryId),
    importPaths: (_, paths, categoryId) => sources.importPaths(paths, categoryId),
    addUrl: (_, url, title, categoryId) => sources.addUrl(url, title, categoryId),
    update: (_, id, patch) => reindexAfter(sources.updateSource(id, patch)),
    open: (_, id) => sources.openSource(id),
    reveal: (_, id) => sources.revealSource(id),
    trash: (_, id) => reindexAfter(sources.trashSource(id))
  },
  trash: {
    list: () => trash.listTrash(),
    restore: (_, type, id) => reindexAfter(trash.restore(type, id)),
    purge: async (_, type, id) => reindexAfter(await trash.purge(type, id)),
    empty: () => trash.emptyTrash()
  },
  providers: {
    list: () => providers.listProviders(),
    save: (_, input) => providers.saveProvider(input),
    remove: (_, id) => providers.removeProvider(id),
    fetchModels: (_, id) => providers.fetchModels(id),
    test: (_, id) => providers.testProvider(id)
  },
  chat: {
    conversations: () => chat.listConversations(),
    messages: (_, id) => chat.listMessages(id),
    send: (_, input) => chat.send(input),
    stop: (_, id) => chat.stop(id),
    threads: (_, parentId) => chat.listThreads(parentId),
    saveAnswer: (_, input) => saveAnswer(input),
    update: (_, id, patch) => chat.updateConversation(id, patch),
    remove: (_, id) => chat.deleteConversation(id)
  },
  reflection: {
    overview: () => reflection.reflectionOverview(),
    start: (_, input) => reflection.startReflection(input),
    get: (_, id) => reflection.getReflection(id),
    remove: (_, id) => reflection.removeReflection(id),
    answers: (_, id) => reflection.reflectionAnswers(id),
    material: (_, id) => reflection.reflectionMaterial(id),
    saveDaily: (_, answers) => reflection.saveDaily(answers),
    harvest: (_, id) => reflection.harvestReflection(id),
    commit: (_, id, input) => reflection.commitReflection(id, input)
  },
  goals: {
    list: () => progress.listGoals(),
    save: (_, input) => progress.saveGoal(input),
    remove: (_, id) => progress.removeGoal(id),
    progress: (_, id) => progress.goalProgress(id),
    linkNote: (_, id, noteId, linked) => progress.linkNoteToGoal(id, noteId, linked)
  },
  connections: {
    get: (_, noteId) => connections.noteConnections(noteId),
    relate: (_, noteId, toType, toId) => connections.relate(noteId, toType, toId),
    unrelate: (_, noteId, toType, toId) => connections.unrelate(noteId, toType, toId),
    linkMention: (_, noteId, mentionNoteId, blockId, undo) => connections.linkMention(noteId, mentionNoteId, blockId, undo)
  },
  graph: {
    data: () => knowledgeGraph()
  },
  mastery: {
    map: (_, goalId) => progress.masteryMap(goalId)
  },
  insights: {
    list: () => reflection.listInsights(),
    history: (_, id) => reflection.insightHistory(id),
    update: (_, id, patch) => reflection.updateInsight(id, patch),
    remove: (_, id) => reflection.removeInsight(id)
  },
  actions: {
    list: (_, status) => reflection.listActions(status),
    create: (_, title, dueAt, goalId) => reflection.createAction(title, dueAt, goalId ?? null),
    update: (_, id, patch) => reflection.updateAction(id, patch),
    remove: (_, id) => reflection.removeAction(id)
  },
  feynman: {
    get: (_, id) => chat.getConversation(id),
    finish: (_, id) => feynman.finishFeynman(id),
    addCues: (_, id, indices) => feynman.addFeynmanCues(id, indices)
  },
  review: {
    next: (_, exclude) => review.nextCard(exclude),
    get: (_, id) => review.getCard(id),
    stats: () => review.reviewStats(),
    rate: (_, id, rating, durationMs) => review.rate(id, rating, durationMs),
    undo: (_, id) => review.undoRating(id),
    suspend: (_, id, suspended) => review.suspendCard(id, suspended),
    forNote: (_, noteId) => review.cardsForNote(noteId),
    check: (_, id, answer) => review.checkAnswer(id, answer)
  },
  memory: {
    list: (_, q) => memory.listMemories(q),
    save: (_, input) => memory.saveMemory(input, 'user'),
    remove: (_, id) => memory.removeMemory(id),
    confirm: (_, id) => memory.confirmMemory(id),
    profile: () => memory.getUserProfile(),
    setProfile: (_, patch) => memory.setUserProfile(patch),
    settings: () => memory.getMemorySettings(),
    setSettings: (_, patch) => memory.setMemorySettings(patch),
    concepts: () => learner.listConcepts(),
    removeConcept: (_, id) => learner.removeConcept(id),
    setConceptLevel: (_, id, level) => learner.setConceptLevel(id, level),
    learnNow: (_, id) => memoryLearn.learnFromConversation(id),
    maintain: (_, opts) => memoryLearn.maintain(opts)
  },
  skills: {
    list: () => skills.listSkills(),
    read: (_, name) => skills.readSkillFile(name, 'SKILL.md'),
    setEnabled: (_, name, enabled) => skills.setSkillEnabled(name, enabled),
    import: ({ win }) => skills.importSkill(win),
    importPath: (_, path) => skills.importSkillFrom(path),
    openDir: () => skills.openUserSkillsDir(),
    reload: () => {
      skills.reloadSkills()
      return skills.listSkills()
    }
  },
  asr: {
    status: () => asr.asrStatus(),
    install: () => {
      void asr.installAsr().catch(() => {})
    },
    transcribe: (_, id) => asr.enqueueTranscribe(id),
    importSubtitles: ({ win }, id) => sources.importSubtitlesDialog(win, id)
  },
  recognition: {
    status: () => recognize.recognizerStatus(),
    install: () => {
      void recognize.installRecognizer().catch(() => {})
    },
    remove: () => recognize.removeRecognizer(),
    source: (_, id) => recognize.sourceRecognition(id),
    start: (_, id) => recognize.startRecognition(id)
  },
  embedding: {
    status: async () => {
      await embedding.refreshStatus()
      return { ...embedding.getStatus(), ...indexStats() }
    },
    installLocal: async () => {
      await embedding.installLocal()
      requestIndex()
    },
    reindex: () => {
      clearIndex()
      requestIndex()
    }
  },
  knowledge: {
    search: (_, query, scope, limit) => retrieve(query, scope, limit)
  },
  stats: {
    heatmap: (_, days) => stats.heatmap(days)
  }
}

export function registerIpc(): void {
  for (const [ns, name, def] of eachCapability()) {
    const fn = (handlers as unknown as Record<string, Record<string, (ctx: Ctx, ...a: unknown[]) => unknown>>)[ns][name]
    if (!fn) throw new Error(`Capability ${ns}.${name} has no handler`)
    ipcMain.handle(`${ns}:${name}`, async (e, ...raw) => {
      try {
        const args = parseArgs(def, raw)
        return await fn({ win: BrowserWindow.fromWebContents(e.sender) }, ...args)
      } catch (err) {
        log.error(`[ipc] ${ns}:${name} failed`, err)
        throw err
      }
    })
  }
}

export { capabilities }
