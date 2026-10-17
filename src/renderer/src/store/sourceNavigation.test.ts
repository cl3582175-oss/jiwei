import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openSourceAt, useApp } from './app'

const get = vi.fn()
beforeEach(() => {
  get.mockReset()
  vi.stubGlobal('window', { jiwei: { sources: { get } } })
  useApp.setState({ view: 'notes', noteId: 'note', sourceId: null, sourceReturn: null, browserOpen: false, highlight: null })
})
afterEach(() => vi.unstubAllGlobals())

it('keeps the latest source click when an earlier source lookup finishes late', async () => {
  let resolve!: (value: unknown) => void
  get.mockReturnValueOnce(new Promise((done) => (resolve = done))).mockResolvedValueOnce({ kind: 'pdf' })
  openSourceAt('old-source', new URLSearchParams('page=1'))
  openSourceAt('new-source', new URLSearchParams('page=5'))
  await vi.waitFor(() => expect(useApp.getState().sourceId).toBe('new-source'))
  resolve({ kind: 'pdf' })
  await Promise.resolve()
  await Promise.resolve()
  expect(useApp.getState()).toMatchObject({ sourceId: 'new-source', highlight: { sourceId: 'new-source', locator: 'page=5' } })
})

it('does not reopen a source after the reader was closed while its lookup was pending', async () => {
  let resolve!: (value: unknown) => void
  get.mockReturnValueOnce(new Promise((done) => (resolve = done)))
  openSourceAt('late-source', new URLSearchParams('page=3'))
  useApp.getState().openSource(null)
  resolve({ kind: 'pdf' })
  await Promise.resolve()
  await Promise.resolve()
  expect(useApp.getState().sourceId).toBeNull()
})
