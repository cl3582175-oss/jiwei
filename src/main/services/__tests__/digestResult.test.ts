import { expect, it } from 'vitest'
import { f, settle, source, start } from './digestFixture'

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
