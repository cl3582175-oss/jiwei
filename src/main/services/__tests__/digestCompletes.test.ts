import { expect, it } from 'vitest'
import { f, settle, source, start } from './digestFixture'

it('保存的云端资料在分批整理和最终总结中保留来源限制', async () => {
  await source()
  f.sql!.prepare('UPDATE sources SET web_origin=? WHERE id=?').run(
    JSON.stringify({ provider: 'deepseek', urlVerified: false, truncated: true }),
    'source'
  )
  const { jobId } = await start()
  const result = await settle(jobId)
  expect(result.status, result.error ?? '').toBe('done')
  expect(f.calls.length).toBeGreaterThanOrEqual(2)
  expect(f.calls.every((prompt) => prompt.includes('DeepSeek 云端读取') && prompt.includes('不能据此声称官网已确认'))).toBe(true)
})

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
