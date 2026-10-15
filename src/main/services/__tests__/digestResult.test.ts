import { expect, it } from 'vitest'
import { f, settle, source, start } from './digestFixture'

it('参数错误在创建笔记和调度模型前永久拒绝', async () => {
  await source(false)
  const { startDigest } = await import('../digest')
  expect(() => startDigest({ sourceId: 'source', task: 'invalid' as never, providerId: 'controlled', model: 'controlled' })).toThrow(
    'Invalid digest parameters'
  )
  expect(f.calls).toHaveLength(0)
})

it('汇总后目标被用户锁定时结果落到新笔记并通知重定向', async () => {
  await source(false)
  const { createNote, updateNote } = await import('../notes')
  const original = createNote({ title: 'Original' }).id
  f.beforeOutput = (_prompt, map) => {
    if (!map) updateNote(original, { aiExcluded: true })
  }
  const { jobId } = await start(original)
  const result = await settle(jobId)
  expect(result.status, result.error ?? '').toBe('done')
  const saved = f.sql!.prepare('SELECT note_id,ops FROM proposals').get() as { note_id: string; ops: string }
  expect(saved.note_id).not.toBe(original)
  expect(saved.ops).toContain('总结')
  expect(f.events.find((e) => e.name === 'digest:done')?.payload).toMatchObject({ noteId: saved.note_id, redirectedFrom: original })
})

it('发起时目标已锁定则确认卡片提示，并改为新笔记', async () => {
  await source(false)
  const { createNote } = await import('../notes')
  const original = createNote({ title: 'Locked', userAiExcluded: true }).id
  const { describeDigest } = await import('../digest')
  expect(
    describeDigest(
      { sourceId: 'source', noteId: original, conversationId: 'own', task: 'summary', providerId: 'controlled', model: 'controlled' },
      true
    ).detail
  ).toContain('目标笔记现在不能由 AI 写入，结果会放进一篇新笔记。')
  const { jobId, noteId } = await start(original)
  expect(noteId).not.toBe(original)
  expect((await settle(jobId)).status).toBe('done')
  expect(f.sql!.prepare('SELECT note_id FROM proposals').get()).toEqual({ note_id: noteId })
})

it('汇总后原笔记被删除也保存到新笔记，源资料删除则立即停止', async () => {
  await source(false)
  const { createNote, trashNote } = await import('../notes')
  const original = createNote({ title: 'Deleted target' }).id
  f.beforeOutput = (_prompt, map) => {
    if (!map) trashNote(original)
  }
  const { jobId } = await start(original)
  expect((await settle(jobId)).status).toBe('done')
  expect((f.sql!.prepare('SELECT note_id FROM proposals').get() as { note_id: string }).note_id).not.toBe(original)
})

it('源资料中途撤销时不保存结果，永久失败不再整任务重试', async () => {
  await source(false)
  f.beforeOutput = (_prompt, map) => {
    if (!map) f.sql!.exec("UPDATE sources SET ai_excluded=1 WHERE id='source'")
  }
  const { jobId } = await start()
  expect((await settle(jobId)).status).toBe('failed')
  expect(f.sql!.prepare('SELECT attempts FROM jobs WHERE id=?').get(jobId)).toEqual({ attempts: 1 })
  expect(f.sql!.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({ n: 0 })
})
