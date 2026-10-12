import * as pluginMarkets from './services/plugins/markets'
import * as updates from './services/updates'
import * as importer from './services/importer/run'
import * as pluginDirect from './services/plugins/direct'
import * as pluginAuthoring from './services/plugins/authoring'
import * as pluginManim from './services/plugins/manim'
import * as plugins from './services/plugins/install'
import * as pluginRoles from './services/plugins/roles'
import * as pluginStarters from './services/plugins/starters'
import * as pluginRegistry from './services/plugins/registry'
import { tr } from './lib/messages'
import * as plan from './services/plan/calendar'
import * as planPhases from './services/plan/phases'
import * as planIcs from './services/plan/ics'
import * as planSchedule from './services/plan/schedule'
import * as tasks from './services/tasks/service'
import { taskToolCatalog } from './services/tasks/tools'
import { applyResidency } from './services/tasks/residency'
import * as mail from './services/mail/accounts'
import * as discoverFeeds from './services/discover/feeds'
import * as discoverSearch from './services/discover/search'
import * as discoverItems from './services/discover/items'
import * as discoverDaily from './services/discover/daily'
import * as discoverPath from './services/discover/path'
import * as discoverPodcast from './services/discover/podcast'
import * as advisor from './services/advisor'
import * as insightsSvc from './services/insights'
import * as worksSvc from './services/works'
import * as worksExport from './services/works/export'
import * as worksVideo from './services/works/video'
import * as discoverTts from './services/discover/tts'
import * as localSpeech from './services/discover/localSpeech'
import { MAIL_PRESETS } from '@shared/mail'
import * as browserCapture from './services/browser/capture'
import * as mistakes from './services/mistakes'
import * as mistakeEntries from './services/mistakeEntries'
import * as reading from './services/reading'
import * as vocabulary from './services/vocabulary'
import { mistakeStatistics } from './services/learningStatistics'
import * as capture from './services/capture'
import * as phone from './services/phoneUpload'
import * as inbox from './services/inbox'
import * as recording from './services/recording'
import * as people from './services/people'
import * as voiceprint from './services/voiceprint'
import * as lenses from './services/lenses'
import * as lensLanding from './services/lensLanding'
import * as series from './services/series'
import { personPage } from './services/personPage'
import { voiceErrorText } from './services/voiceMessages'
import { VoiceValidationError } from '@shared/recording'
import { getMainWindow } from './mainWindow'
import { queueNoteImages, recognizeNoteFormula } from './services/noteImages'
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { basename, join } from 'path'
import { writeFile } from 'fs/promises'
import * as fullBackup from './services/fullBackup'
import * as recordingFiles from './services/recordingFiles'
import * as browserNetwork from './services/browser/network'
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
import * as activity from './services/activity'
import * as today from './services/today'
import * as assets from './services/assets'
import * as appSvc from './services/app'
import { getSettings, setSettings } from './services/settings'
import * as proposals from './services/proposals'
import * as segments from './services/segments'
import * as jobs from './services/jobs'
import * as vaults from './services/vaults'
import { getProfile, setProfileName } from './services/device'
import { requestRendererFlush, resolveFlush } from './lifecycle'
import * as providers from './services/ai/providers'
import * as chat from './services/ai/chat'
import * as embedding from './services/ai/embedding'
import { clearIndex, indexStats, requestIndex, sourceIndexStatus } from './services/ai/indexer'
import { retrieve } from './services/ai/retrieve'
import * as memory from './services/memory'
import * as learner from './services/learner'
import * as memoryLearn from './services/memoryLearn'
import * as review from './services/review'
import * as feynman from './services/feynman'
import * as reflection from './services/reflection'
import * as progress from './services/progress'
import * as connections from './services/connections'
import { sourceOutline } from './services/digest'
import { knowledgeGraph } from './services/graph'
import * as asr from './services/asr'
import * as recognize from './services/recognize'
import * as annotations from './services/annotations'
import * as browser from './services/browser/manager'
import * as pages from './services/browser/pages'
import * as course from './services/browser/course'
import * as courseLearning from './services/browser/courseLearning'
import * as moss from './services/moss'
import { refreshConcepts } from './services/browser/concepts'
import { saveAnswer } from './services/saveAnswer'
import { exportNote } from './services/exportNote'
import { registerSandbox } from './services/sandbox'
import * as skills from './services/ai/skills'
import * as usage from './services/agent/usage'
import * as balance from './services/agent/balance'
import * as rates from './services/agent/rates'
import { displayCurrency, fromUsd } from '@shared/money'
import * as approval from './services/agent/approval'
import * as auditLog from './services/agent/audit'
import * as mcpClient from './services/mcp/client'
import * as mcpServe from './services/mcp/serve'

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

const pluginRoleOwners = new Set<number>()
const pluginAcquisitionOwners = new Set<number>()
const handlers: Handlers = {
  mistakes: {
    create: (_, input) => mistakeEntries.createManual(input),
    fromInbox: (_, id) => mistakeEntries.fromInbox(id),
    fromBrowserCapture: (_, id) => mistakeEntries.fromBrowserCapture(id),
    get: (_, id) => mistakes.get(id),
    list: (_, filters) => mistakes.list(filters),
    update: (_, id, patch) => mistakes.update(id, patch),
    retry: (_, id) => mistakes.retry(id),
    prepare: (_, id) => mistakes.prepare(id),
    complete: (_, id, proposalId, update) => mistakes.complete(id, proposalId, update),
    remove: (_, id) => mistakes.remove(id),
    removeComplete: (_, id, proposalId, update) => mistakes.removeComplete(id, proposalId, update),
    practice: (_, id) => mistakes.practice(id),
    replenish: (_, id, immediate) => mistakes.replenish(id, immediate),
    flag: (_, id) => mistakes.flag(id),
    check: (_, id, variantId, answer) => mistakes.check(id, variantId, answer),
    useVariant: (_, id) => mistakes.useVariant(id),
    variants: (_, id) => mistakes.variants(id),
    variantStats: () => mistakes.variantStats(),
    statistics: () => mistakeStatistics()
  },
  reading: {
    state: (_, target) => reading.state(target),
    configure: (_, input) => reading.configure(input),
    estimate: (_, target) => reading.estimate(target),
    translate: (_, input) => reading.translate(input),
    profile: () => vocabulary.profile(),
    setThreshold: (_, threshold) => vocabulary.setThreshold(threshold),
    recognize: (_, word) => vocabulary.recognize(word),
    query: (_, word) => vocabulary.query(word),
    prepare: (_, input) => vocabulary.prepare(input),
    complete: (_, proposalId, update) => vocabulary.complete(proposalId, update),
    clearCache: () => reading.clearCache(),
    cacheStats: () => reading.cacheStats(),
    usage: (_, target) => reading.usage(target)
  },
  lenses: {
    list: () => skills.listLenses(),
    save: (_, input, id) => skills.saveLens(input, id),
    remove: (_, id) => skills.removeLens(id),
    guess: (_, id) => lenses.guessScene(id),
    chooseScene: (_, id, scene) => lenses.chooseScene(id, scene),
    run: (_, input) => lenses.runLens(input),
    history: (_, id) => lenses.history(id),
    estimate: (_, id) => lenses.estimate(id),
    duplicates: (_, id) => lensLanding.duplicates(id),
    landings: (_, id) => lensLanding.listLandings(id),
    prepare: (_, input) => lensLanding.prepare(input),
    complete: (_, id, update) => lensLanding.complete(id, update),
    undo: (_, id) => lensLanding.undo(id),
    undoComplete: (_, id, update) => lensLanding.undoComplete(id, update)
  },
  series: {
    list: () => series.listSeries(),
    save: (_, input, id) => series.saveSeries(input, id),
    set: (_, id, seriesId) => series.setRecordingSeries(id, seriesId),
    detail: (_, id) => series.seriesDetail(id),
    openActions: (_, id) =>
      series
        .seriesActions(id)
        .filter((a) => a.status === 'open')
        .slice(0, 5)
  },
  recording: {
    cryptoStatus: () => recordingFiles.cryptoStatus(),
    prepareRecovery: () => recordingFiles.prepareRecovery(),
    confirmRecovery: (_, group) => recordingFiles.confirmRecovery(group),
    cancelRecovery: () => recordingFiles.cancelRecovery(),
    saveRecovery: async () => {
      const code = recordingFiles.pendingRecovery(),
        result = await dialog.showSaveDialog({
          title: tr('保存录音恢复码', 'Save recording recovery code'),
          defaultPath: tr('积微录音恢复码.txt', 'Jiwei-recording-recovery-code.txt'),
          filters: [{ name: tr('文本文件', 'Text file'), extensions: ['txt'] }]
        })
      if (!result.canceled && result.filePath)
        await writeFile(
          result.filePath,
          tr(
            `积微录音恢复码\n${code}\n请保存在安全的位置。换电脑或从备份恢复时需要此码。\n`,
            `Jiwei recording recovery code\n${code}\nKeep it somewhere safe. You need it on a new computer or when restoring from a backup.\n`
          ),
          { mode: 0o600 }
        )
    },
    unlock: (_, code) => recordingFiles.unlockRecordings(code),
    encryption: (_, enabled, confirmed) => recordingFiles.setRecordingEncryption(enabled, confirmed),
    deferEncryption: () => recordingFiles.deferRecordingEncryption(),
    pauseMigration: () => recordingFiles.cryptoOperation.cancel(),
    resumeMigration: () => recordingFiles.resumeCryptoMigration(),
    list: () => recording.listRecordings(),
    get: (_, id) => recording.getRecording(id),
    begin: (_, input) => recording.beginRecording(input),
    chunk: (_, input) => recording.writeRecordingChunk(input),
    pause: (_, id, paused) => recording.pauseRecording(id, paused),
    finish: (_, id) => recording.finishRecording(id),
    discard: (_, id) => recording.discardRecording(id),
    restore: (_, id) => recording.restoreRecording(id),
    mark: (_, id, marker) => recording.markRecording(id, marker),
    summarize: (_, id) => recording.summarizeRecent(id),
    permissions: () => recording.recordingPermissions(),
    requestMic: () => recording.requestMicrophone(),
    openMicSettings: () => recording.openMicrophoneSettings(),
    storage: () => recording.recordingStorage(),
    deleteAudio: (_, id) => recording.deleteRecordingAudio(id),
    speakers: (_, id) => people.listSpeakers(id),
    confirm: (_, input) => people.confirmSpeaker(input),
    export: ({ win }, id, format) => people.exportTranscript(win, id, format)
  },
  people: {
    page: (_, id) => personPage(id),
    list: () => people.listPeople(),
    save: (_, input, id) => people.savePerson(input, id),
    remove: (_, id) => people.removePerson(id),
    merge: (_, from, to) => people.mergePeople(from, to),
    clear: (_, names, id) => people.clearVoiceprints(names, id),
    corrections: () => people.listCorrections(),
    removeCorrection: (_, id) => people.removeCorrection(id)
  },
  voiceprint: {
    status: () => voiceprint.voiceprintStatus(),
    install: () => {
      void voiceprint.installVoiceprint().catch(() => {})
    },
    remove: () => voiceprint.removeVoiceprint(),
    enroll: (_, bytes) => voiceprint.enrollVoiceprint(bytes)
  },
  capture: {
    open: (_, mode) => capture.open(mode),
    state: () => capture.current(),
    close: () => capture.close(),
    shortcuts: () => capture.shortcutStatus(),
    context: ({ win }, id, noteId) => capture.context(id, noteId, win),
    delivered: ({ win }, id, error) => capture.delivered(id, error, win),
    paste: (_, id) => capture.paste(id),
    attach: (_, id, bytes, name, mime) => capture.attach(id, bytes, name, mime),
    crop: (_, id, rect) => capture.crop(id, rect),
    action: (_, input) => capture.action(input)
  },
  phone: { start: () => phone.start(), status: () => phone.status(), stop: (_, id) => phone.stop(id) },
  inbox: {
    list: (_, deleted) => inbox.list(deleted),
    get: (_, id) => inbox.get(id),
    create: (_, input) => inbox.create(input),
    update: (_, id, patch) => inbox.update(id, patch),
    remove: (_, id) => inbox.remove(id),
    restore: (_, id) => inbox.restore(id),
    retryRecognition: (_, id) => inbox.retryRecognition(id),
    accept: (_, id, manual) => inbox.accept(id, manual),
    complete: (_, id, update) => inbox.complete(id, update),
    triage: (_, ids) => inbox.triage(ids, undefined, true),
    estimate: () => inbox.estimate()
  },
  app: {
    showInFolder: (_, path) => shell.showItemInFolder(path),
    info: () => appSvc.appInfo(),
    openDataDir: () => appSvc.openDataDir(),
    changeDataDir: ({ win }) => appSvc.changeDataDir(win),
    flushDone: ({ win }) => resolveFlush(win)
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
    create: (_, includeProfile) => fullBackup.fullBackupNow(includeProfile),
    status: () => fullBackup.backupStatus(),
    export: (_, includeProfile) => fullBackup.exportBackup(includeProfile),
    preview: (_, name) => fullBackup.previewBackup(name),
    restore: (_, input) => fullBackup.restoreBackup(input),
    cancel: () => fullBackup.backupOperation.cancel(),
    pickExternal: () => fullBackup.pickExternalBackup(),
    reveal: async () => {
      await shell.openPath(backupsDir())
    }
  },
  settings: {
    get: () => getSettings(),
    set: (_, patch) => {
      const before = JSON.stringify(getSettings().ai.recognition ?? null)
      const r = setSettings(patch)
      if (patch.tasks) {
        if (patch.tasks.paused !== undefined) tasks.pauseAll(patch.tasks.paused)
        applyResidency()
      }
      if (patch.capture) capture.refreshShortcuts()
      // 换了识别引擎或开启插图解读：有待识别页的资料按新设置排队
      if (patch.ai && JSON.stringify(patch.ai.recognition ?? null) !== before) recognize.queuePending()
      if (patch.mcpServe) void mcpServe.startServe()
      if (patch.browser) {
        browser.refreshPrivacy()
        if (patch.browser.course) browser.refreshCourseSettings(patch.browser.course)
        refreshConcepts()
      }
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
    update: (_, id, patch) => {
      const result = notes.updateNote(id, patch)
      if (patch.aiExcluded === false) queueNoteImages()
      return patch.aiExcluded !== undefined || patch.status !== undefined ? reindexAfter(result) : result
    },
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
    resolve: (_, id, opIndex, decision, blockIds) => proposals.resolveUserOp(id, opIndex, decision, blockIds)
  },
  segments: {
    update: (_, id, text) => reindexAfter(segments.updateSegmentText(id, text)),
    list: (_, sourceId) => segments.listSegments(sourceId),
    search: (_, query, sourceId) => segments.searchSegments(query, sourceId)
  },
  jobs: {
    list: () => jobs.listJobs(),
    cancel: (_, id) => jobs.cancelJob(id),
    retry: (_, id) => jobs.retryJob(id),
    runNow: (_, id) => jobs.runJobNow(id)
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
    indexStatus: (_, id) => sourceIndexStatus(id),
    notes: (_, id) => connections.notesForSource(id),
    outline: (_, id) => sourceOutline(id),
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
    save: (_, input) => {
      const saved = providers.saveProvider(input)
      if (input.modelCaps) usage.backfillUnpriced(saved.id)
      return saved
    },
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
  learningInsights: { get: (_, range) => insightsSvc.insights(range) },
  works: {
    list: () => worksSvc.listWorks(),
    get: (_, id) => worksSvc.getWork(id),
    create: (_, input) => worksSvc.createWork(input),
    update: (_, input) => worksSvc.updateWork(input),
    remove: (_, id) => worksSvc.removeWork(id),
    topics: (_, id) => worksSvc.suggestTopics(id),
    gather: (_, id, query) => worksSvc.gatherMaterials(id, query),
    dropMaterial: (_, id, materialId) => worksSvc.removeMaterial(id, materialId),
    outline: (_, id) => worksSvc.generateOutline(id),
    draft: (_, id, partId) => worksSvc.draftWork(id, partId),
    polish: (_, id) => worksSvc.polishWork(id),
    unclearToCards: (_, id, indexes) => worksSvc.unclearToCards(id, indexes),
    export: (ctx, id, format) => worksExport.exportWork(ctx.win, id, format),
    render: (_, id) => worksVideo.renderVideo(id),
    renderStatus: (_, id) => worksVideo.renderStatus(id),
    cancelRender: (_, id) => worksVideo.cancelRender(id),
    exportVideo: (ctx, id, format) => worksVideo.exportVideo(ctx.win, id, format)
  },
  advisor: {
    list: () => advisor.listDecisions(),
    get: (_, id) => advisor.getDecision(id),
    due: () => advisor.dueDecisions(),
    ask: (_, input) => advisor.ask(input),
    regenerate: (_, id) => advisor.regenerate(id),
    weights: (_, id, weights) => advisor.setWeights(id, weights),
    decide: (_, input) => advisor.decide(input),
    review: (_, input) => advisor.reviewDecision(input),
    status: (_, id, status) => advisor.setStatus(id, status),
    remove: (_, id) => advisor.removeDecision(id)
  },
  discover: {
    feeds: () => discoverFeeds.listFeeds(),
    feedSave: (_, input) => discoverFeeds.saveFeed(input),
    feedRemove: (_, id) => discoverFeeds.removeFeed(id),
    feedRefresh: (_, id) => discoverFeeds.refreshFeed(id),
    items: (_, all) => discoverItems.items(all),
    act: (_, input) => discoverItems.act(input),
    runNow: () => discoverDaily.runNow(),
    status: () => discoverDaily.dailyStatus(),
    searchProviders: () => discoverSearch.searchProviders(),
    searchSave: (_, input) => discoverSearch.searchSave(input),
    searchTest: (_, service) => discoverSearch.searchTest(service),
    path: (_, goalId) => discoverPath.path(goalId),
    pathPhases: (_, id) => discoverPath.pathPhases(id),
    remedy: (_, id) => discoverPath.remedy(id),
    podcast: () => discoverPodcast.podcast(),
    podcastGenerate: () => discoverPodcast.generatePodcast(),
    ttsProviders: () => discoverTts.ttsProviders(),
    speechStatus: () => localSpeech.localSpeechStatus(),
    speechInstall: () => localSpeech.installLocalSpeech(),
    speechCancel: () => localSpeech.cancelLocalSpeech(),
    speechRemove: () => localSpeech.removeLocalSpeech(),
    voicePreview: (_, engine, voice, providerId) => discoverPodcast.previewVoice(engine, voice, providerId)
  },
  mail: {
    help: async (_, preset) => {
      await shell.openExternal(MAIL_PRESETS[preset].help)
    },
    accounts: () => mail.accounts(),
    save: (_, input) => mail.saveAccount(input),
    test: (_, id) => mail.testAccount(id),
    remove: (_, id) => mail.removeAccount(id)
  },
  tasks: {
    list: () => tasks.listTasks(),
    save: (_, input) => tasks.saveTask(input),
    remove: (_, id) => tasks.removeTask(id),
    run: (_, id) => tasks.queueTask(id),
    runs: (_, id) => tasks.taskRuns(id),
    parse: (_, text) => tasks.parseTask(text),
    recipes: () => tasks.recipes(),
    tools: async () => (await taskToolCatalog()).info,
    pauseAll: (_, paused) => tasks.pauseAll(paused),
    chooseFolder: async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }
  },
  plan: {
    schedulePreview: (_, input) => planSchedule.schedulePreview(input),
    scheduleApply: (_, id) => planSchedule.scheduleApply(id),
    phases: (_, id) => planPhases.phases(id),
    phaseSave: (_, input) => planPhases.phaseSave(input),
    phaseRemove: (_, id) => planPhases.phaseRemove(id),
    milestones: (_, id) => planPhases.milestones(id),
    milestoneSave: (_, input) => planPhases.milestoneSave(input),
    milestoneRemove: (_, id) => planPhases.milestoneRemove(id),
    icsFeeds: () => planIcs.feeds(),
    icsSave: (_, input) => planIcs.save(input),
    icsRefresh: (_, id) => planIcs.refresh(id),
    icsRemove: (_, id) => planIcs.remove(id),
    icsImport: () => planIcs.importFile(),
    events: (_, range) => plan.events(range),
    eventSave: (_, input) => plan.eventSave(input),
    eventRemove: (_, id) => plan.eventRemove(id),
    forecast: (_, days) => plan.forecast(days)
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
    home: () => feynman.feynmanHome(),
    finish: (_, id) => feynman.finishFeynman(id),
    addCues: (_, id, indices) => feynman.addFeynmanCues(id, indices)
  },
  review: {
    forecast: (_, days) => plan.forecast(days),
    next: (_, exclude) => review.nextCard(exclude),
    get: (_, id) => review.getCard(id),
    list: (_, filter, search) => review.listCards(filter, search),
    today: () => review.todayCards(),
    scheduledNow: (_, id) => review.isScheduledNow(id),
    practice: (_, id, durationMs) => review.practiceCard(id, durationMs),
    stats: () => review.reviewStats(),
    rate: (_, id, rating, durationMs, variantId) => review.rate(id, rating, durationMs, variantId),
    undo: (_, id) => review.undoRating(id),
    suspend: (_, id, suspended) => review.suspendCard(id, suspended),
    forNote: (_, noteId) => review.cardsForNote(noteId),
    check: (_, id, answer, variantId) => review.checkAnswer(id, answer, variantId)
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
    transcribe: (_, id, overwrite) => asr.enqueueTranscribe(id, overwrite),
    importSubtitles: ({ win }, id) => sources.importSubtitlesDialog(win, id)
  },
  browser: {
    networkStatus: () => browserNetwork.networkStatus(),
    networkRules: (_, rules) => browserNetwork.setNetworkRules(rules),
    openExternal: (_, id) => browser.openExternalTab(id),
    externalSite: (_, site, enabled) => browser.setExternalSite(site, enabled),
    dismissLogin: (_, id) => browser.dismissLogin(id),
    state: () => browser.browserState(),
    seek: (_, id, t, play) => browser.seek(id, t, play),
    playback: (_, id, play) => browser.playback(id, play),
    open: ({ win }, input, opts) => {
      if (win) browser.attach(win)
      const active = browser.getTab()
      if (opts?.newTab === false && active && !opts.incognito) {
        browser.navigate(active.id, input || 'about:blank')
        return active.id
      }
      return browser.openTab(input, { incognito: opts?.incognito })
    },
    navigate: (_, id, input) => browser.navigate(id, input),
    command: (_, id, cmd) => browser.command(id, cmd),
    activate: (_, id) => browser.activateTab(id),
    close: (_, id) => browser.closeTab(id),
    setBounds: ({ win }, rect) => browser.setBounds(win, rect),
    captureBegin: () => browserCapture.begin(),
    captureRecognize: (_, id, rect) => browserCapture.recognize(id, rect),
    captureRelease: (_, id) => browserCapture.release(id),
    capturePrepare: (_, id, commit, requireCurrent) => browserCapture.prepare(id, commit, requireCurrent),
    captureSaved: (_, proposalId) => browserCapture.saved(proposalId),
    captureSave: (_, entries, noteId) => browserCapture.save(entries, noteId),
    freeze: (_, on) => browser.freeze(on),
    saveSource: (_, id) => pages.saveTab(id),
    recapCheck: (_, id) => pages.shouldRecap(id),
    recap: (_, sourceId, noteId) => pages.recapToNote(sourceId, noteId),
    readPage: (_, id) => pages.readPage(id)
  },
  course: {
    configure: (_, id, patch) => course.configureCourse(id, patch),
    snapshot: (_, id) => course.snapshot(id),
    organize: (_, sourceId, noteId) => courseLearning.organizeCourse(sourceId, noteId),
    estimate: (_, sourceId) => courseLearning.organizeEstimate(sourceId),
    quiz: (_, id) => courseLearning.makeCourseQuiz(id),
    check: (_, id, answer) => courseLearning.checkCourseAnswer(id, answer),
    review: (_, id, noteId) => courseLearning.reviewCourseQuiz(id, noteId)
  },
  moss: {
    status: () => moss.mossStatus(),
    install: () => {
      void moss.installMoss().catch(() => {})
    },
    remove: () => moss.removeMoss(),
    refine: (_, sourceId, overwrite) => moss.enqueueMoss(sourceId, overwrite)
  },
  annotations: {
    list: (_, type, id) => annotations.listAnnotations(type, id),
    recent: (_, since) => annotations.recentAnnotations(since),
    create: (_, input) => annotations.createAnnotation(input),
    update: (_, id, patch) => annotations.updateAnnotation(id, patch),
    remove: (_, id) => annotations.removeAnnotation(id),
    restore: (_, id) => annotations.removeAnnotation(id, true),
    exportPdf: ({ win }, id) => annotations.exportAnnotatedPdf(id, win)
  },
  recognition: {
    scanPages: (_, id) => recognize.scanPageTexts(id),
    formula: async (_, noteId, imageId) => {
      await requestRendererFlush()
      docs.derive(noteId)
      return recognizeNoteFormula(noteId, imageId)
    },
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
    search: (_, query, scope, limit, filters) => retrieve(query, scope, limit, filters)
  },
  stats: {
    heatmap: (_, days) => stats.heatmap(days)
  },
  activity: {
    track: (_, spans) => activity.trackSpans(spans),
    clear: () => activity.clearActivity()
  },
  today: {
    summary: () => today.todaySummary(),
    briefing: (_, refresh) => today.todayBriefing(refresh)
  },
  usage: {
    summary: () => usage.usageSummary(),
    allowToday: () => usage.allowToday(),
    clear: () => usage.clearUsage(),
    dashboard: (_, range) => usage.dashboard(range),
    calls: (_, filter) => usage.calls(filter),
    exportCsv: async ({ win }, filter) => {
      const opts = {
        defaultPath: join(app.getPath('documents'), `jiwei-usage-${filter.from}-${filter.to}.csv`),
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      }
      const testDir = !app.isPackaged ? process.env.JIWEI_EXPORT_DIR : undefined
      const file = testDir
        ? join(testDir, basename(opts.defaultPath))
        : (win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)).filePath
      if (!file) return null
      const money = getSettings().money
      const code = displayCurrency(money)
      await writeFile(
        file,
        usage.callsCsv(filter, (v) => fromUsd(v, code, money), code)
      )
      return file
    },
    balances: () => balance.balances(),
    updateRates: () => rates.updateRates()
  },
  agent: {
    decide: (_, d) => approval.decide(d.id, d.allow),
    pending: () => approval.pendingApprovals(),
    audit: (_, q) => auditLog.listAudit(q),
    auditCallers: () => auditLog.auditCallers(),
    exportAudit: async ({ win }) => {
      const opts = {
        defaultPath: join(app.getPath('documents'), `jiwei-audit-${new Date().toISOString().slice(0, 10)}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const testDir = !app.isPackaged ? process.env.JIWEI_EXPORT_DIR : undefined
      const file = testDir
        ? join(testDir, basename(opts.defaultPath))
        : (win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)).filePath
      if (!file) return null
      await writeFile(file, JSON.stringify(auditLog.listAudit({ limit: 100000 }), null, 2))
      return file
    },
    clearAudit: () => auditLog.clearAudit()
  },
  manim: {
    status: () => pluginManim.manimStatus(),
    install: (_, options) => {
      // 安装要几分钟：后台进行，进度通过 plugins:changed 通知
      void pluginManim.installManim(options).catch(() => undefined)
    },
    cancel: () => pluginManim.cancelManim(),
    remove: () => pluginManim.removeManim(),
    clip: (_, animation) => pluginManim.animationClip(animation)
  },
  plugins: {
    roleCatalog: () => pluginRoles.roleCatalog(),
    beginRoleSelection: ({ win }) => {
      if (!win) throw new Error('Window unavailable')
      const owner = win.webContents.id
      if (!pluginRoleOwners.has(owner)) {
        pluginRoleOwners.add(owner)
        win.webContents.once('destroyed', () => {
          pluginRoleOwners.delete(owner)
          void pluginRoles.cancelOwnerRoleSelections(owner)
        })
      }
      return pluginRoles.beginRoleSelection(owner)
    },
    previewRoles: ({ win }, token, ids) => pluginRoles.previewRoles(win?.webContents.id ?? -1, token, ids),
    confirmRoles: ({ win }, token, selections) => pluginRoles.confirmRoles(win?.webContents.id ?? -1, token, selections),
    cancelRoleSelection: ({ win }, token) => pluginRoles.cancelRoleSelection(win?.webContents.id ?? -1, token),
    roleRecovery: () => pluginRoles.roleRecovery(),
    roleStarters: () => pluginStarters.listRoleStarters(),
    activateStarter: (_, pluginId, starterId) => pluginStarters.completeRoleStarter(pluginId, starterId),
    dismissStarters: (_, pluginId) => pluginStarters.dismissRoleStarters(pluginId),
    markets: () => pluginMarkets.listMarkets(),
    catalog: () => pluginMarkets.catalogPlugins(),
    addMarket: (_, input) => pluginMarkets.addMarket(input),
    removeMarket: (_, name, options) => pluginMarkets.removeMarket(name, options),
    refreshMarket: (_, name, staleOnly) => pluginMarkets.refreshMarkets(name, staleOnly),
    beginAcquisition: ({ win }) => {
      if (!win) throw new Error('Window unavailable')
      const owner = win.webContents.id
      if (!pluginAcquisitionOwners.has(owner)) {
        pluginAcquisitionOwners.add(owner)
        win.webContents.once('destroyed', () => {
          pluginAcquisitionOwners.delete(owner)
          void pluginDirect.cancelOwnerAcquisitions(owner)
        })
      }
      return pluginDirect.beginAcquisition(owner)
    },
    acquire: ({ win }, id, source) => pluginDirect.detectGithub(win?.webContents.id ?? -1, id, source),
    acquireUpdate: ({ win }, id, pluginId) => pluginDirect.acquireUpdate(win?.webContents.id ?? -1, id, pluginId),
    acquireFile: ({ win }, id) => pluginDirect.detectFile(win?.webContents.id ?? -1, id, win),
    acquirePath: ({ win }, id, path) => {
      if (app.isPackaged || process.env.JIWEI_TEST_PLUGINS !== '1') throw new Error('Test-only plugin path inspector is disabled')
      return pluginDirect.detectPath(win?.webContents.id ?? -1, id, path)
    },
    cancelAcquisition: ({ win }, id) => pluginDirect.cancelAcquisition(win?.webContents.id ?? -1, id),
    selectSkills: ({ win }, id, token, paths) => pluginDirect.selectDetectedSkills(win?.webContents.id ?? -1, id, token, paths),
    addDetectedMarket: ({ win }, id, token) => pluginDirect.addDetectedMarket(win?.webContents.id ?? -1, id, token),
    details: (_, input) => plugins.pluginDetails(input),
    list: () => plugins.listPlugins(),
    get: (_, id) => plugins.getPlugin(id),
    inspect: (_, source) => plugins.inspectPlugin(source),
    installFromFile: ({ win }) => plugins.installPluginFromFile(win),
    inspectPath: (_, path) => {
      if (app.isPackaged || process.env.JIWEI_TEST_PLUGINS !== '1') throw new Error('Test-only plugin path inspector is disabled')
      return plugins.inspectPluginPath(path)
    },
    confirmInstall: (_, token, options) => plugins.confirmPluginInstall(token, options),
    cancel: (_, token) => plugins.cancelPluginPreview(token),
    update: (_, id) => plugins.updatePlugin(id),
    rollback: (_, id) => plugins.rollbackPlugin(id),
    setEnabled: (_, id, enabled) => plugins.setPluginEnabled(id, enabled),
    setConfig: (_, id, values) => plugins.setPluginConfig(id, values),
    uninstall: (_, id, options) => plugins.uninstallPlugin(id, options),
    openFolder: (_, id) => plugins.openPluginFolder(id),
    customize: (_, id) => pluginAuthoring.customizePlugin(id),
    createRolePack: (_, input) => pluginAuthoring.createRolePack(input),
    acquireAuthored: ({ win }, id, name) => pluginDirect.detectPath(win?.webContents.id ?? -1, id, pluginAuthoring.authoredPath(name)),
    openAuthored: async (_, name) => {
      await shell.openPath(pluginAuthoring.authoredPath(name))
    },
    exportPlugin: ({ win }, id, withMarketplace) =>
      pluginAuthoring.exportPlugin(id, win, withMarketplace, app.isPackaged ? undefined : process.env.JIWEI_TEST_EXPORT_DIR),
    templates: () => pluginRegistry.listTemplates(),
    frameworks: () => pluginRegistry.listFrameworks(),
    recipes: () => pluginRegistry.listRecipes()
  },
  mcp: {
    servers: () => mcpClient.listServers(),
    saveServer: (_, input) => mcpClient.saveServer(input),
    removeServer: (_, id) => mcpClient.removeServer(id),
    testServer: (_, id) => mcpClient.testServer(id),
    logoutServer: (_, id) => mcpClient.logoutServer(id),
    setToolPolicy: (_, input) => mcpClient.setToolPolicy(input.serverId, input.tool, input.policy),
    serveStatus: () => mcpServe.serveStatus(),
    clients: () => mcpServe.listClients(),
    createClient: (_, input) => mcpServe.createClient(input.name, input.access),
    updateClient: (_, id, patch) => mcpServe.updateClient(id, patch),
    rotateToken: (_, id) => mcpServe.rotateToken(id),
    removeClient: (_, id) => mcpServe.removeClient(id)
  },
  updates: {
    status: () => updates.getUpdateState(),
    check: () => updates.checkUpdates(),
    download: () => updates.downloadUpdate(),
    install: () => updates.installUpdate(),
    acknowledge: () => updates.acknowledgeUpgrade(),
    openLink: (_, url) => updates.openUpdateLink(url)
  },
  importer: {
    choose: ({ win }, mode) => importer.chooseLibrary(win, mode),
    inspect: (_, paths) => { if (app.isPackaged || process.env.JIWEI_TEST_IMPORT !== '1') throw new Error('Test-only path scanning is disabled'); return importer.beginScan(paths) },
    scan: (_, id) => importer.getScan(id),
    cancelScan: (_, id) => importer.cancelScan(id),
    preview: (_, id, path) => importer.preview(id, path),
    estimate: (_, id, paths) => importer.estimate(id, paths),
    start: (_, id, options) => importer.beginImport(id, options),
    run: (_, id) => importer.getRun(id),
    history: () => importer.listRuns(),
    cancel: (_, id) => importer.cancelImport(id),
    cancelCues: (_, id) => importer.cancelCues(id),
    undo: (_, id) => importer.undoImport(id)
  }
}

export function registerIpc(): void {
  for (const [ns, name, def] of eachCapability()) {
    const fn = (handlers as unknown as Record<string, Record<string, (ctx: Ctx, ...a: unknown[]) => unknown>>)[ns][name]
    if (!fn) throw new Error(`Capability ${ns}.${name} has no handler`)
    ipcMain.handle(`${ns}:${name}`, async (e, ...raw) => {
      // 内置浏览器中的网页不得调用积微的接口（内容脚本只走 jw-page:* 消息）
      if (browser.isBrowserContents(e.sender)) throw new Error('Forbidden')
      if (['updates', 'importer'].includes(ns) && (e.sender !== getMainWindow()?.webContents || e.senderFrame !== e.sender.mainFrame)) throw new Error('Forbidden')
      if (
        ['recording', 'people', 'voiceprint', 'lenses', 'series', 'plugins'].includes(ns) &&
        (e.sender !== getMainWindow()?.webContents || e.senderFrame !== e.sender.mainFrame)
      )
        throw new Error('Forbidden')
      try {
        const args = parseArgs(def, raw)
        return await fn({ win: BrowserWindow.fromWebContents(e.sender) }, ...args)
      } catch (err) {
        log.error(`[ipc] ${ns}:${name} failed`, err)
        if (err instanceof VoiceValidationError) throw new Error(voiceErrorText(err), { cause: err })
        throw err
      }
    })
  }
}

export { capabilities }
