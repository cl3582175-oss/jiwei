import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const f = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sql: null as Database.Database | null,
  dir: '',
  ready: false,
  events: [] as string[],
  listeners: new Map<string, Set<() => void>>()
}))
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql, dataDir: () => f.dir, assetsDir: () => join(f.dir, 'assets') }))
vi.mock('../../events', () => ({
  emit: (event: string) => {
    f.events.push(event)
    f.listeners.get(event)?.forEach((fn) => fn())
  },
  onMainEvent: (event: string, fn: () => void) => {
    const listeners = f.listeners.get(event) ?? new Set<() => void>()
    listeners.add(fn)
    f.listeners.set(event, listeners)
    return () => listeners.delete(fn)
  }
}))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN', isPackaged: false },
  nativeImage: {},
  net: {},
  protocol: {},
  BrowserWindow: {},
  dialog: {},
  shell: {}
}))
vi.mock('../device', () => ({ deviceId: () => 'test-device' }))
vi.mock('../recording', () => ({
  recordingForSource: () => null,
  recordingAudio: () => null,
  purgeRecording: async () => {},
  restoreRecording: () => {}
}))
vi.mock('../recordingFiles', () => ({ recordingKey: () => null, recordingPlainSize: () => 0, recordingStream: () => null }))
vi.mock('../recognize', () => ({
  recognizingSources: () => [],
  IMAGE_EXTS: new Set(['png', 'jpg']),
  maybeAutoRecognize: () => {},
  applyRecognized: () => {},
  recordPages: () => {}
}))
vi.mock('../asr', () => ({
  isMedia: (ext: string) => ['mp3', 'mp4'].includes(ext),
  canAutoTranscribe: () => false,
  findSidecarSubtitles: () => null,
  enqueueTranscribe: () => {},
  applySubtitleFile: () => {}
}))
vi.mock('../moss', () => ({ mossStatus: () => ({ state: 'missing' }), enqueueMoss: () => {} }))
vi.mock('../ai/embedding', () => ({
  isReady: async () => f.ready,
  currentModelId: () => 'controlled',
  embed: async (texts: string[]) => texts.map(() => [1, 0]),
  setStatus: () => {}
}))
vi.mock('../recognizeRuntimes', () => ({}))
vi.mock('../notes', () => ({ deleteNoteRow: () => {} }))
vi.mock('../docs', () => ({ purgeDocData: () => {}, setTextLink: () => {} }))
vi.mock('../proposals', () => ({ deleteProposalsForNote: () => {} }))

import { listSources, importPaths, getSource, updateSource } from '../sources'
import { replaceSegments, searchSegments } from '../segments'
import { restore } from '../trash'
import { retrieve } from '../ai/retrieve'
import { desiredChunks } from '../ai/indexer'
import { check } from '../retrieval/privacyGuard'
import { assetPath } from '../assets'
import { relatedByVectors } from '../connections'
import { knowledgeGraph } from '../graph'
vi.mock('../progress', () => ({ masteryMap: () => ({ notes: [] }) }))

beforeEach(() => {
  f.dir = mkdtempSync(join(tmpdir(), 'jiwei-attachment-unit-'))
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  const folder = join(process.cwd(), 'resources/migrations')
  for (const file of readdirSync(folder)
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(folder, file), 'utf8'))
  f.sql.exec('DROP TABLE vec_chunks; CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[2] distance_metric=cosine)')
  f.db = drizzle(f.sql)
  f.events = []
  f.ready = false
  for (const id of ['c1', 'c2', 'private'])
    f.sql
      .prepare('INSERT INTO conversations(id,title,incognito,created_at,updated_at) VALUES(?,?,?,1,1)')
      .run(id, id, id === 'private' ? 1 : 0)
  f.sql.exec("INSERT INTO decisions(id,question,created_at,updated_at) VALUES('decision','choice',1,1)")
})
afterEach(() => {
  f.sql?.close()
  rmSync(f.dir, { recursive: true, force: true })
})

const svc = () => import('../attachments')
function file(name = 'secret.txt', text = 'ZZ-ATTACH-MARKER-7f3a'): string {
  const path = join(f.dir, name)
  writeFileSync(path, text)
  return path
}
async function attachment(owner?: string) {
  return (await (await svc()).addAttachments({ paths: [file()], conversationId: owner }))[0]
}
const rowCount = (table: string): number => (f.sql!.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

it('附件删除、彻底清除与无痕对话结束都会清理来源的步骤缓存', async () => {
  const s = await svc(),
    ordinary = await attachment('c1'),
    privateFile = await attachment('private')
  const add = (id: string) =>
    f.sql!.prepare('INSERT INTO job_steps VALUES(?,?,?,?,?)').run('controlled', id, id, '{"text":"CACHE-MARKER"}', Date.now())
  add(ordinary.sourceId)
  add(privateFile.sourceId)
  s.deleteAttachments([ordinary.sourceId])
  expect(f.sql!.prepare('SELECT source_id FROM job_steps').all()).toEqual([{ source_id: privateFile.sourceId }])
  s.detachConversationAttachments('private')
  expect(rowCount('job_steps')).toBe(0)
  restore('source', ordinary.sourceId)
  add(ordinary.sourceId)
  ;(await import('../sources')).purgeSourceData(ordinary.sourceId)
  expect(rowCount('job_steps')).toBe(0)
})

it('派生笔记归档后解锁，删除或彻底清除已归档附件时重新隔离', async () => {
  const s = await svc(),
    a = await attachment('c1')
  f.sql!.exec(
    "INSERT INTO notes(id,doc_version,learned_at,created_at,edited_at,updated_at,updated_by) VALUES('derived',1,1,1,1,1,'controlled')"
  )
  const { protectNoteAttachments } = await import('../attachmentDerived')
  protectNoteAttachments('derived', [a.sourceId])
  const effective = () => (f.sql!.prepare("SELECT ai_excluded FROM notes WHERE id='derived'").get() as { ai_excluded: number }).ai_excluded
  s.archiveAttachments([a.sourceId], null)
  expect(effective()).toBe(0)
  s.deleteAttachments([a.sourceId])
  expect(effective()).toBe(1)
  restore('source', a.sourceId)
  expect(effective()).toBe(1)
  s.archiveAttachments([a.sourceId], null)
  expect(effective()).toBe(0)
  const { purgeSourceData } = await import('../sources')
  purgeSourceData(a.sourceId)
  expect(effective()).toBe(1)
})

it('默认隐藏附件，只有主动添加的所属会话可读，普通资料隐私开关优先', async () => {
  const s = await svc(),
    a = await attachment('c1')
  expect(getSource(a.sourceId)?.aiExcluded).toBe(true)
  expect(listSources({})).toEqual([])
  expect(listSources({ space: 'attachment' })).toHaveLength(1)
  expect(s.canReadSource(a.sourceId, 'c1')).toBe(true)
  expect(s.canReadSource(a.sourceId, 'c2')).toBe(false)
  expect(s.canReadSource(a.sourceId, null)).toBe(false)
  s.removeFromConversation('c1', a.sourceId)
  expect(s.canReadSource(a.sourceId, 'c1')).toBe(false)
  s.bindAttachments('c1', [a.sourceId], 'u1')
  s.archiveAttachments([a.sourceId], null)
  expect(s.canReadSource(a.sourceId, null)).toBe(true)
  updateSource(a.sourceId, { aiExcluded: true })
  expect(s.canReadSource(a.sourceId, 'c1')).toBe(false)
})

it('决策附件只对有效决策可读，删除和移出立即撤销', async () => {
  const s = await svc(),
    a = await attachment()
  s.bindAttachments('decision', [a.sourceId], null)
  expect(s.canReadSource(a.sourceId, 'decision')).toBe(true)
  expect(s.canReadSource(a.sourceId, 'c1')).toBe(false)
  s.deleteAttachments([a.sourceId])
  expect(s.canReadSource(a.sourceId, 'decision')).toBe(false)
})

it('关键词与向量分段默认排除附件，allow 放行也不能读已删除来源', async () => {
  const s = await svc(),
    a = await attachment('c1')
  replaceSegments(a.sourceId, [{ kind: 'paragraph', text: 'ZZ-ATTACH-MARKER-7f3a', locator: {} }])
  expect(await retrieve('ZZ-ATTACH-MARKER', { type: 'all' })).toEqual([])
  expect(searchSegments('ZZ-ATTACH-MARKER')).toEqual([])
  expect(await retrieve('ZZ-ATTACH-MARKER', { type: 'all' }, 8, {}, null, { sourceIds: [a.sourceId] })).toHaveLength(1)
  s.deleteAttachments([a.sourceId])
  expect(await retrieve('ZZ-ATTACH-MARKER', { type: 'all' }, 8, {}, null, { sourceIds: [a.sourceId] })).toEqual([])
})

it('复用同内容附件和库内资料；资料库导入不把未归档附件隐式开放', async () => {
  const s = await svc(),
    a = await attachment('c1'),
    b = await attachment('c2')
  expect(a.sourceId).toBe(b.sourceId)
  expect(rowCount('sources')).toBe(1)
  expect(s.conversationAttachments('c2')[0].sourceId).toBe(a.sourceId)
  const imported = await importPaths([file()])
  expect(imported.imported).toHaveLength(1)
  expect(rowCount('sources')).toBe(2)
  const c = await attachment('c2')
  expect(c.space).toBe('library')
  expect(c.sourceId).toBe(imported.imported[0].id)
})

it('超限、旧格式、不支持格式给逐文件失败状态，不产生来源行', async () => {
  const s = await svc()
  const items = await s.addAttachments({
    files: [
      { name: 'legacy.doc', data: new Uint8Array([1]) },
      { name: 'unknown.exe', data: new Uint8Array([2]) },
      { name: 'huge.txt', data: new Uint8Array(25 * 1024 * 1024 + 1) }
    ]
  })
  expect(items.map((i) => i.status)).toEqual(['unsupported', 'unsupported', 'failed'])
  expect(items[0].error).toContain('docx')
  expect(rowCount('sources')).toBe(0)
})

it('删除进最近删除，恢复仍未归档；归档后可全局检索并广播变化', async () => {
  const s = await svc(),
    a = await attachment('c1')
  replaceSegments(a.sourceId, [{ kind: 'paragraph', text: 'ZZ-ATTACH-MARKER-7f3a', locator: {} }])
  s.archiveAttachments([a.sourceId], null)
  expect(await retrieve('ZZ-ATTACH-MARKER', { type: 'all' })).toHaveLength(1)
  s.deleteAttachments([a.sourceId])
  restore('source', a.sourceId)
  expect(getSource(a.sourceId)?.space).toBe('attachment')
  expect(getSource(a.sourceId)?.aiExcluded).toBe(true)
  expect(s.unarchivedCount()).toBe(1)
  expect(f.events).toContain('attachments:changed')
})

it('启动清理严格超过24小时的草稿，连同分段、向量和独占资产；边界保留', async () => {
  const s = await svc(),
    a = await attachment(),
    asset = f.sql!.prepare('SELECT asset_id FROM sources WHERE id=?').get(a.sourceId) as { asset_id: string }
  replaceSegments(a.sourceId, [{ kind: 'paragraph', text: 'draft', locator: {} }])
  const now = Date.now()
  f.sql!.prepare('UPDATE sources SET created_at=? WHERE id=?').run(now - 86400000, a.sourceId)
  await s.cleanupDrafts(now)
  expect(getSource(a.sourceId)).not.toBeNull()
  await s.cleanupDrafts(now + 1)
  expect(getSource(a.sourceId)).toBeNull()
  expect(rowCount('source_segments')).toBe(0)
  expect(rowCount('assets')).toBe(0)
  expect(existsSync(assetPath(asset.asset_id, 'txt'))).toBe(false)
})

it('删除普通对话保留附件空间且不被草稿清理误删，无痕独立资料彻底清除', async () => {
  const s = await svc(),
    regular = await attachment('c1'),
    privateItem = await attachment('private')
  expect(privateItem.sourceId).not.toBe(regular.sourceId)
  expect(s.listAttachmentSpace({ state: 'all' }).map((a) => a.sourceId)).toEqual([regular.sourceId])
  s.detachConversationAttachments('private')
  expect(getSource(privateItem.sourceId)).toBeNull()
  expect(getSource(regular.sourceId)).not.toBeNull()
  s.detachConversationAttachments('c1')
  f.sql!.prepare('UPDATE sources SET created_at=1 WHERE id=?').run(regular.sourceId)
  await s.cleanupDrafts()
  expect(getSource(regular.sourceId)).not.toBeNull()
  expect(s.conversationAttachments('c1')).toEqual([])
  expect(s.listAttachmentSpace({ state: 'all' })).toHaveLength(1)
})

it('草稿无向量、无痕无向量；已绑定普通附件有向量候选但没有跨对话读取', async () => {
  const draft = await attachment(),
    normal = await attachment('c1'),
    priv = await attachment('private')
  const s = await svc()
  // normal 与 draft 内容相同，会复用；另造真正的未绑定草稿。
  const [unbound] = await s.addAttachments({ paths: [file('draft.txt', 'unique draft')] })
  for (const id of [draft.sourceId, normal.sourceId, priv.sourceId, unbound.sourceId])
    replaceSegments(id, [{ kind: 'paragraph', text: 'ZZ-ATTACH-MARKER-7f3a', locator: {} }])
  expect(
    desiredChunks()
      .filter((c) => c.parentType === 'source')
      .map((c) => c.parentId)
  ).toEqual([normal.sourceId])
  expect(check('secret document title')).toBe(true)
})

it('附件标题与正文不参与联网隐私黑名单，库内不给AI内容仍拦截', async () => {
  const a = await attachment('c1')
  replaceSegments(a.sourceId, [{ kind: 'paragraph', text: 'unique hidden private document body', locator: {} }])
  expect(check('secret')).toBe(true)
  expect(check('unique hidden private document body')).toBe(true)
  await (await svc()).archiveAttachments([a.sourceId], null)
  updateSource(a.sourceId, { aiExcluded: true })
  expect(check('secret')).toBe(false)
  expect(check('unique hidden private document body')).toBe(false)
})

it('真实向量候选回表、相关推荐与图谱都排除未归档附件，显式放行和归档可用', async () => {
  const s = await svc(),
    a = await attachment('c1')
  replaceSegments(a.sourceId, [{ kind: 'paragraph', text: 'ZZ-ATTACH-MARKER-7f3a', locator: {} }])
  const segment = f.sql!.prepare('SELECT id FROM source_segments WHERE source_id=?').get(a.sourceId) as { id: string }
  f.sql!.prepare(
    "INSERT INTO chunks(rowid,owner_type,owner_id,parent_type,parent_id,hash,model,created_at) VALUES(1,'segment',?,'source',?,'h','controlled',1)"
  ).run(segment.id, a.sourceId)
  const vector = Buffer.from(new Float32Array([1, 0]).buffer)
  f.sql!.prepare('INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)').run(1n, vector)
  f.sql!.exec("INSERT INTO notes(id,title,learned_at,created_at,updated_at,edited_at) VALUES('note','ordinary',1,1,1,1);")
  f.sql!.exec(
    "INSERT INTO chunks(rowid,owner_type,owner_id,parent_type,parent_id,hash,model,created_at) VALUES(2,'block','ordinary-block','note','note','h','controlled',1);"
  )
  f.sql!.prepare('INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)').run(2n, vector)
  f.sql!.prepare(
    "INSERT INTO links(id,from_type,from_id,to_type,to_id,relation,origin,created_at,updated_at) VALUES('citation','note','note','source',?,'reference','doc',1,1)"
  ).run(a.sourceId)
  f.ready = true
  expect(await retrieve('unrelated keyword', { type: 'all' })).toEqual([])
  expect(await retrieve('unrelated keyword', { type: 'all' }, 8, {}, null, { sourceIds: [a.sourceId] })).toHaveLength(1)
  expect(await relatedByVectors('note', new Set())).toEqual([])
  expect(knowledgeGraph().nodes.some((n) => n.id === a.sourceId)).toBe(false)
  s.archiveAttachments([a.sourceId], null)
  expect(await retrieve('unrelated keyword', { type: 'all' })).toHaveLength(1)
  expect(await relatedByVectors('note', new Set())).toHaveLength(1)
  expect(knowledgeGraph().nodes.some((n) => n.id === a.sourceId)).toBe(true)
})

it('无痕草稿在发送前已隐藏，普通附件的不给 AI 开关不可解除', async () => {
  const s = await svc()
  const [a] = await s.addAttachments({ paths: [file()], incognito: true })
  expect(s.unarchivedCount()).toBe(0)
  expect(s.listAttachmentSpace({ state: 'all' })).toEqual([])
  expect(() => updateSource(a.sourceId, { aiExcluded: false })).toThrow('Archive')
  const [bound] = s.bindAttachments('private', [a.sourceId], 'u-private')
  expect(bound).toBe(a.sourceId)
  expect(s.canReadSource(bound, 'private')).toBe(true)
  expect(s.unarchivedCount()).toBe(0)
})

it('短附件首次全文是外部数据，后续不重复，单附件点名才再发', async () => {
  const s = await svc(),
    a = await attachment('c1')
  replaceSegments(a.sourceId, [{ kind: 'paragraph', text: 'ZZ-ATTACH-MARKER-7f3a', locator: {} }])
  f.sql!.exec("UPDATE jobs SET status='done'")
  const { prepareAttachmentTurn, markAttachmentTurnSent } = await import('../ai/chatAttachments')
  const first = await prepareAttachmentTurn('c1', '总结', true, 'normal', false)
  expect(first.full[0].text).toContain('ZZ-ATTACH-MARKER-7f3a')
  expect(first.section).toContain('【本对话的附件】')
  markAttachmentTurnSent('c1', first.sentIds)
  expect((await prepareAttachmentTurn('c1', '第二轮继续', true, 'normal', false)).full).toEqual([])
  expect((await prepareAttachmentTurn('c1', '这份附件再解释', true, 'normal', false)).full).toHaveLength(1)
  s.removeFromConversation('c1', a.sourceId)
  expect((await prepareAttachmentTurn('c1', '继续', true, 'normal', false)).section).toBe('')
})

it('长附件不发全文、处理状态可见；短附件全文合计不超过30000字', async () => {
  const s = await svc()
  const items = await s.addAttachments({
    files: ['a', 'b', 'c', 'long'].map((name) => ({ name: name + '.txt', data: new TextEncoder().encode(name) })),
    conversationId: 'c1'
  })
  items.forEach((a, i) => replaceSegments(a.sourceId, [{ kind: 'paragraph', text: '文'.repeat(i === 3 ? 12001 : 11000), locator: {} }]))
  f.sql!.exec("UPDATE jobs SET status='done'")
  const { prepareAttachmentTurn } = await import('../ai/chatAttachments')
  const turn = await prepareAttachmentTurn('c1', '总结', true, 'normal', false)
  expect(turn.full).toHaveLength(2)
  expect(turn.full.reduce((n, t) => n + t.text.length, 0)).toBe(22000)
  expect(turn.full.some((t) => t.sourceId === items[3].sourceId)).toBe(false)
  f.sql!.prepare("UPDATE jobs SET status='queued' WHERE json_extract(payload,'$.sourceId')=?").run(items[3].sourceId)
  expect((await prepareAttachmentTurn('c1', '继续', true, 'normal', false)).section).toContain('解析中')
})

it('图片只在首次参与时发图，最多4张，仍允许后续读取识别文字', async () => {
  const s = await svc(),
    png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  const [a] = await s.addAttachments({ files: [{ name: 'photo.png', data: png }], conversationId: 'c1' })
  f.sql!.exec("UPDATE jobs SET status='done'")
  const { prepareAttachmentTurn, markAttachmentTurnSent } = await import('../ai/chatAttachments')
  const turn = await prepareAttachmentTurn('c1', '解释图片', true, 'normal', true)
  expect(turn.images).toHaveLength(1)
  expect(turn.images[0]).toMatch(/^data:image\/png;base64,/)
  markAttachmentTurnSent('c1', turn.sentIds)
  replaceSegments(a.sourceId, [{ kind: 'paragraph', text: '图中文字', locator: {} }])
  const next = await prepareAttachmentTurn('c1', '继续', true, 'normal', true)
  expect(next.images).toEqual([])
  expect(next.full[0].text).toBe('图中文字')
})

it('表格上下文每表只含前200行，给出总行数；关闭组件时不推荐chart', async () => {
  const s = await svc(),
    [a] = await s.addAttachments({ files: [{ name: 'sheet.csv', data: new TextEncoder().encode('a,b') }], conversationId: 'c1' })
  const { tableSegments } = await import('../parsers/ooxml')
  replaceSegments(
    a.sourceId,
    tableSegments(
      'Data',
      Array.from({ length: 302 }, (_, i) => ({ row: i + 1, cells: [i === 0 ? 'name' : `row-${i}`, 'value'] }))
    )
  )
  f.sql!.exec("UPDATE jobs SET status='done'")
  const { prepareAttachmentTurn } = await import('../ai/chatAttachments')
  const turn = await prepareAttachmentTurn('c1', '总结', true, 'normal', false)
  expect(turn.full[0].text).toContain('row-200')
  expect(turn.full[0].text).not.toContain('row-201')
  expect(turn.full[0].text).toContain('301')
  expect(turn.section).toContain('chart / table')
  expect((await prepareAttachmentTurn('c1', '总结', true, 'off', false)).section).not.toContain('chart / table')
})

it('附件引用权限撤销后旧助手消息不可复用，记忆整理也不能拿到复述', async () => {
  const s = await svc(),
    a = await attachment('c1')
  const { attachmentHistoryReadable, hasPrivateAttachmentHistory } = await import('../attachmentsAccess')
  expect(hasPrivateAttachmentHistory('c1')).toBe(true)
  const context = JSON.stringify({ attachmentSourceIds: [a.sourceId] })
  expect(attachmentHistoryReadable(context, 'c1')).toBe(true)
  s.removeFromConversation('c1', a.sourceId)
  expect(attachmentHistoryReadable(context, 'c1')).toBe(false)
  expect(hasPrivateAttachmentHistory('c1')).toBe(true)
  s.archiveAttachments([a.sourceId], null)
  expect(hasPrivateAttachmentHistory('c1')).toBe(false)
})

it('附件派生笔记保留引用但不可进入其他 AI；归档前不得解除隔离', async () => {
  const a = await attachment('c1')
  f.sql!.exec("INSERT INTO notes(id,doc_version,learned_at,created_at,edited_at,updated_at,updated_by) VALUES('derived',1,1,1,1,1,'test')")
  f.sql!.prepare(
    "INSERT INTO proposals(id,note_id,title,ops,op_status,status,created_at) VALUES('p','derived','saved',?,'[]','pending',1)"
  ).run(JSON.stringify({ ops: [] }))
  const { protectProposalAttachments, noteHasPrivateAttachments } = await import('../attachmentDerived')
  protectProposalAttachments('p', [a.sourceId])
  expect(f.sql!.prepare("SELECT ai_excluded FROM notes WHERE id='derived'").get()).toEqual({ ai_excluded: 1 })
  expect(noteHasPrivateAttachments('derived')).toBe(true)
  ;(await svc()).archiveAttachments([a.sourceId], null)
  expect(noteHasPrivateAttachments('derived')).toBe(false)
})

it('无痕草稿同一输入框去重，不同输入框独立，归档后删除对话保留归档列表身份', async () => {
  const s = await svc(),
    path = file('private-draft.txt', 'private-draft-content')
  const [a] = await s.addAttachments({ paths: [path], incognito: true, draftId: 'draft1' })
  const [same] = await s.addAttachments({ paths: [path], incognito: true, draftId: 'draft1' })
  const [other] = await s.addAttachments({ paths: [path], incognito: true, draftId: 'draft2' })
  expect(same.sourceId).toBe(a.sourceId)
  expect(other.sourceId).not.toBe(a.sourceId)
  expect(s.listAttachmentSpace({ state: 'all' })).toHaveLength(0)
  const ordinary = await attachment('c1')
  s.archiveAttachments([ordinary.sourceId], null)
  s.detachConversationAttachments('c1')
  expect(s.listAttachmentSpace({ state: 'archived' }).map((a) => a.sourceId)).toContain(ordinary.sourceId)
})

it('直接写入的附件派生笔记来源持久隔离，失败整理的标题也不能打开AI', async () => {
  const a = await attachment('c1')
  f.sql!.exec(
    "INSERT INTO notes(id,title,doc_version,learned_at,created_at,edited_at,updated_at,updated_by) VALUES('direct','PRIVATE-TITLE-MARKER',1,1,1,1,1,'test')"
  )
  const { protectNoteAttachments, noteHasPrivateAttachments } = await import('../attachmentDerived')
  protectNoteAttachments('direct', [a.sourceId])
  expect(f.sql!.prepare("SELECT ai_excluded FROM notes WHERE id='direct'").get()).toEqual({ ai_excluded: 1 })
  expect(noteHasPrivateAttachments('direct')).toBe(true)
  await (await svc()).deleteAttachments([a.sourceId])
  expect(noteHasPrivateAttachments('direct')).toBe(true)
})

it('表格检索只回前200个数据行，后面的片段不能单独绕过限制', async () => {
  const a = await attachment('c1')
  const { tableSegments } = await import('../parsers/ooxml')
  replaceSegments(
    a.sourceId,
    tableSegments('sparse', [
      { row: 1, cells: ['name', 'value'] },
      ...Array.from({ length: 300 }, (_, i) => ({
        row: (i + 1) * 10,
        cells: [i === 249 ? 'ROW250-NOT-FOR-MODEL' : `row${i}`, String(i)]
      }))
    ])
  )
  const hits = await retrieve('ROW250-NOT-FOR-MODEL', { type: 'all' }, 12, {}, null, { sourceIds: [a.sourceId] })
  expect(JSON.stringify(hits)).not.toContain('ROW250-NOT-FOR-MODEL')
  const { tablePreview } = await import('../../lib/attachmentText')
  const { listSegments } = await import('../segments')
  const all = listSegments(a.sourceId)
  expect(
    tablePreview(all)
      .map((s) => s.text)
      .join('\n')
  ).toContain('| row199 | 199 |')
  expect(
    tablePreview([all[4]])
      .map((s) => s.text)
      .join('\n')
  ).not.toContain('ROW250-NOT-FOR-MODEL')
})

it('组件写入共享待办与日程不能绕过附件隔离，归档后才放行', async () => {
  const a = await attachment('c1')
  f.sql!.exec(
    "INSERT INTO messages(id,conversation_id,role,content,created_at,updated_at) VALUES('answer','c1','assistant','private reply',1,1)"
  )
  const { canShareDerived } = await import('../ui')
  expect(canShareDerived('answer')).toBe(false)
  ;(await svc()).archiveAttachments([a.sourceId], null)
  expect(canShareDerived('answer')).toBe(true)
  expect(canShareDerived('missing')).toBe(false)
})

it('附件失败原因中英本地化，不向界面回传系统路径', async () => {
  const { setMessageLanguage } = await import('../../lib/messages')
  const s = await svc(),
    path = join(f.dir, 'missing.txt')
  try {
    setMessageLanguage('zh-CN')
    expect((await s.addAttachments({ paths: [path] }))[0].error).toBe('文件不存在或已移动，请重新选择。')
    setMessageLanguage('en')
    expect((await s.addAttachments({ paths: [path] }))[0].error).toBe('The file is missing or has moved. Please select it again.')
  } finally {
    setMessageLanguage('zh-CN')
  }
})

it('资料库引用和已归档的表格在附件会话里仍受200行限制，普通库检索保持原行为', async () => {
  const a = await attachment('c1')
  const { tableSegments } = await import('../parsers/ooxml')
  replaceSegments(
    a.sourceId,
    tableSegments('Sheet', [
      { row: 1, cells: ['name'] },
      ...Array.from({ length: 300 }, (_, i) => ({ row: i + 2, cells: [i === 249 ? 'LIBRARY-ROW250-BOUND' : `row${i}`] }))
    ])
  )
  ;(await svc()).archiveAttachments([a.sourceId], null)
  expect(JSON.stringify(await retrieve('LIBRARY-ROW250-BOUND', { type: 'all' }))).toContain('LIBRARY-ROW250-BOUND')
  expect(JSON.stringify(await retrieve('LIBRARY-ROW250-BOUND', { type: 'all' }, 12, {}, null, { sourceIds: [a.sourceId] }))).not.toContain(
    'LIBRARY-ROW250-BOUND'
  )
})

it('new library imports invalidate cached title routes through the real source event', async () => {
  const { matchSourcesByTitle } = await import('../ai/sourceMentions')
  expect(matchSourcesByTitle('NEW-614', { type: 'all' })).toEqual([])
  const imported = await importPaths([file('NEW-614-synthetic.xls', 'Synthetic event-driven source')])
  expect(matchSourcesByTitle('NEW-614', { type: 'all' })[0]?.sourceId).toBe(imported.imported[0].id)
})
