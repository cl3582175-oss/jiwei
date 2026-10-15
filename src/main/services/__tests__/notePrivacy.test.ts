import { expect, it } from 'vitest'
import { f, source } from './digestFixture'
import { createNote, getNote, updateNote } from '../notes'
import { protectNoteAttachments, protectProposalAttachments } from '../attachmentDerived'
import { createProposal } from '../proposals'
import Database from 'better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

async function privacy() {
  return import('../notePrivacy')
}

it('单一迁移保守保留旧用户锁，并同时创建复合主键步骤表', () => {
  const sql = new Database(':memory:')
  try {
    sql.loadExtension(getLoadablePath())
    const folder = join(process.cwd(), 'resources/migrations')
    for (const file of readdirSync(folder)
      .filter((p) => p.endsWith('.sql') && p < '0038_')
      .sort())
      sql.exec(readFileSync(join(folder, file), 'utf8'))
    sql.exec(
      "INSERT INTO notes(id,ai_excluded,doc_version,learned_at,created_at,edited_at,updated_at,updated_by) VALUES('legacy',1,1,1,1,1,1,'controlled')"
    )
    sql.exec(readFileSync(join(folder, '0038_long_task_reliability.sql'), 'utf8'))
    expect(sql.prepare("SELECT ai_excluded,user_ai_excluded FROM notes WHERE id='legacy'").get()).toEqual({
      ai_excluded: 1,
      user_ai_excluded: 1
    })
    sql.exec("INSERT INTO job_steps VALUES('job','step','source','{}',1)")
    expect(() => sql.exec("INSERT INTO job_steps VALUES('job','step','source','{}',1)")).toThrow(/UNIQUE/)
  } finally {
    sql.close()
  }
})
async function derived(userAiExcluded = false) {
  await source()
  const id = createNote({ userAiExcluded }).id
  protectNoteAttachments(id, ['source'])
  return id
}

it('用户锁与附件范围分开，用户关闭自己的开关仍保留系统锁', async () => {
  const id = await derived(true)
  expect(getNote(id)).toMatchObject({ aiExcluded: true, attachmentOnly: true })
  expect((await privacy()).canUseNote(id, 'own')).toBe(false)
  updateNote(id, { aiExcluded: false })
  expect(getNote(id)).toMatchObject({ aiExcluded: false, attachmentOnly: true })
  expect(f.sql!.prepare('SELECT ai_excluded FROM notes WHERE id=?').get(id)).toEqual({ ai_excluded: 1 })
  expect((await privacy()).canUseNote(id, 'own')).toBe(true)
})

it('只有附件时所属对话可用，其他对话、后台与撤销关系不可用', async () => {
  const id = await derived()
  const { canUseNote, privateAttachmentsOf } = await privacy()
  expect(privateAttachmentsOf(id)).toEqual(['source'])
  expect(canUseNote(id, 'own')).toBe(true)
  expect(canUseNote(id, 'other')).toBe(false)
  expect(canUseNote(id, null)).toBe(false)
  f.sql!.exec("UPDATE conversation_attachments SET removed_at=2 WHERE source_id='source'")
  expect(canUseNote(id, 'own')).toBe(false)
})

it('所有未归档来源都必须属于对话；来源缺失或笔记删除均不可用', async () => {
  const id = await derived()
  protectNoteAttachments(id, ['missing'])
  expect((await privacy()).canUseNote(id, 'own')).toBe(false)
  expect((await privacy()).canUseNote('missing-note', 'own')).toBe(false)
  f.sql!.prepare('UPDATE notes SET deleted_at=2 WHERE id=?').run(id)
  expect((await privacy()).canUseNote(id, 'own')).toBe(false)
})

it('归档后自动解除系统锁；用户锁仍生效', async () => {
  const id = await derived()
  const locked = createNote({ userAiExcluded: true }).id
  protectNoteAttachments(locked, ['source'])
  f.sql!.exec("UPDATE sources SET space='library',ai_excluded=0 WHERE id='source'")
  ;(await privacy()).refreshNotePrivacy([id, locked])
  expect(getNote(id)).toMatchObject({ aiExcluded: false, attachmentOnly: false })
  expect((await privacy()).canUseNote(id, null)).toBe(true)
  expect(f.sql!.prepare('SELECT ai_excluded FROM notes WHERE id=?').get(locked)).toEqual({ ai_excluded: 1 })
})

it('删除附件不公开派生内容，提案来源也会施加系统锁', async () => {
  await source()
  const id = createNote().id
  const p = createProposal({ noteId: id, title: 'Controlled', ops: [{ op: 'append_summary', nodes: [{ type: 'paragraph' }] }] })
  protectProposalAttachments(p.id, ['source'])
  f.sql!.exec("DELETE FROM sources WHERE id='source'")
  ;(await privacy()).refreshNotePrivacy([id])
  expect(getNote(id)).toMatchObject({ aiExcluded: false, attachmentOnly: true })
  expect(f.sql!.prepare('SELECT ai_excluded FROM notes WHERE id=?').get(id)).toEqual({ ai_excluded: 1 })
  expect((await privacy()).canUseNote(id, null)).toBe(false)
})

it('回填保留纯用户锁，解开已归档派生笔记，只运行一次', async () => {
  await source(false)
  const pure = createNote({ userAiExcluded: true }).id
  const archived = createNote({ userAiExcluded: true }).id
  protectNoteAttachments(archived, ['source'])
  const { backfillNotePrivacy } = await privacy()
  backfillNotePrivacy()
  expect(getNote(pure)).toMatchObject({ aiExcluded: true, attachmentOnly: false })
  expect(getNote(archived)).toMatchObject({ aiExcluded: false, attachmentOnly: false })
  updateNote(archived, { aiExcluded: true })
  backfillNotePrivacy()
  expect(getNote(archived)?.aiExcluded).toBe(true)
})

it('回填识别未归档文档来源与提案来源，仍保持生效排除', async () => {
  const doc = await derived(true)
  const proposal = createNote({ userAiExcluded: true }).id
  f.sql!.prepare(
    "INSERT INTO proposals(id,note_id,title,ops,op_status,status,created_at) VALUES('legacy',?,'Controlled',?,'[]','pending',1)"
  ).run(proposal, JSON.stringify({ ops: [], attachmentSourceIds: ['source'] }))
  ;(await privacy()).backfillNotePrivacy()
  for (const id of [doc, proposal]) {
    expect(getNote(id)).toMatchObject({ aiExcluded: false, attachmentOnly: true })
    expect(f.sql!.prepare('SELECT ai_excluded FROM notes WHERE id=?').get(id)).toEqual({ ai_excluded: 1 })
  }
})

it('AI列表继续使用生效排除，不能把附件开关的false当成公开', async () => {
  const id = await derived()
  f.sql!.prepare('UPDATE notes SET title=? WHERE id=?').run('PRIVATE-DERIVED-MARKER', id)
  expect(getNote(id)).toMatchObject({ aiExcluded: false, attachmentOnly: true })
  const { findNotes, NoteFindInput } = await import('../ai/readData')
  expect(findNotes(NoteFindInput.parse({ query: 'PRIVATE-DERIVED-MARKER' }), { type: 'all' }).items).toEqual([])
})

it('归档过的附件被彻底删除后，派生笔记保持公开；附件管理里删除已归档附件则重新上锁', async () => {
  const id = await derived()
  const { releaseAttachments, unreleaseAttachments, refreshNotePrivacy } = await privacy()
  f.sql!.exec("UPDATE sources SET space='library',ai_excluded=0 WHERE id='source'")
  releaseAttachments(['source'])
  f.sql!.exec("DELETE FROM sources WHERE id='source'")
  refreshNotePrivacy([id])
  expect(getNote(id)).toMatchObject({ aiExcluded: false, attachmentOnly: false })
  unreleaseAttachments(['source'])
  refreshNotePrivacy([id])
  expect(getNote(id)).toMatchObject({ attachmentOnly: true })
})

it('迁移把已归档的对话附件记为公开', () => {
  const sql = new Database(':memory:')
  try {
    sql.loadExtension(getLoadablePath())
    const folder = join(process.cwd(), 'resources/migrations')
    for (const file of readdirSync(folder)
      .filter((p) => p.endsWith('.sql') && p < '0038_')
      .sort())
      sql.exec(readFileSync(join(folder, file), 'utf8'))
    sql.exec(
      "INSERT INTO conversations(id,title,created_at,updated_at) VALUES('c','c',1,1); INSERT INTO sources(id,title,kind,space,ai_excluded,created_at,accessed_at,updated_at,updated_by) VALUES('arch','a','document','library',0,1,1,1,'t'),('priv','p','document','attachment',1,1,1,1,'t'); INSERT INTO conversation_attachments(conversation_id,source_id,created_at) VALUES('c','arch',1),('c','priv',1)"
    )
    sql.exec(readFileSync(join(folder, '0038_long_task_reliability.sql'), 'utf8'))
    expect(sql.prepare('SELECT source_id FROM released_attachments').all()).toEqual([{ source_id: 'arch' }])
  } finally {
    sql.close()
  }
})
