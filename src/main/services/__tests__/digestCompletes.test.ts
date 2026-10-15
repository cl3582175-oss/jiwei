import { expect, it } from 'vitest'
import { f, settle, source, start } from './digestFixture'

it('所属对话的附件总结完成并持久化提案', async () => {
  await source()
  const { jobId, noteId } = await start()
  const result = await settle(jobId)
  expect(result.status, result.error ?? '').toBe('done')
  expect(f.sql!.prepare('SELECT note_id FROM proposals WHERE note_id=?').all(noteId)).toHaveLength(1)
  expect(f.sql!.prepare('SELECT ai_excluded FROM notes WHERE id=?').get(noteId)).toEqual({ ai_excluded: 1 })
})

it('附件在任务中途归档后仍完成，派生笔记解除系统限制', async () => {
  await source()
  f.beforeOutput = (_prompt, map) => {
    if (!map) f.sql!.exec("UPDATE sources SET space='library',ai_excluded=0 WHERE id='source'")
  }
  const { jobId, noteId } = await start()
  const result = await settle(jobId)
  expect(result.status, result.error ?? '').toBe('done')
  expect(f.sql!.prepare('SELECT note_id FROM proposals WHERE note_id=?').all(noteId)).toHaveLength(1)
  expect(f.sql!.prepare('SELECT ai_excluded FROM notes WHERE id=?').get(noteId)).toEqual({ ai_excluded: 0 })
})
