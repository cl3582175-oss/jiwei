import { expect, it } from 'vitest'
import { f, settle, source, start } from './digestFixture'

it('36批中第20批暂时失败，任务续跑不重读前19批', async () => {
  const ids = await source(false, 36)
  let failures = 2
  f.beforeOutput = (prompt, map) => {
    if (map && prompt.includes(`[${ids[19]}]`) && failures-- > 0) throw new Error('HTTP 503 overloaded')
  }
  const { jobId } = await start()
  const result = await settle(jobId)
  expect(result.status, result.error ?? '').toBe('done')
  for (const id of ids.slice(0, 19))
    expect(
      f.calls.filter((p) => p.includes(`[${id}]`)),
      id
    ).toHaveLength(1)
})
