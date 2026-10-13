import { beforeEach, expect, it } from 'vitest'
import { useApp } from '../app'
beforeEach(() =>
  useApp.setState({
    view: 'library',
    noteId: null,
    sourceId: null,
    sourceReturn: null,
    browserOpen: false,
    history: [{ view: 'library', noteId: null, sourceId: null }],
    historyIndex: 0,
    conversationId: 'conversation',
    decisionId: 'decision',
    workId: 'work',
    reflectionId: 'reflection',
    goalId: 'goal'
  })
)
it.each(['library', 'today', 'chat', 'inbox'] as const)('returns a source opened from %s to its origin', (view) => {
  useApp.setState({ view })
  useApp.getState().openSource('source')
  expect(useApp.getState()).toMatchObject({ view: 'notes', noteId: null, sourceId: 'source' })
  useApp.getState().openSource(null)
  expect(useApp.getState()).toMatchObject({ view, sourceId: null, conversationId: 'conversation' })
})
it('keeps a saved note beside its source while closing back to the library and records new navigation', () => {
  useApp.getState().openSource('source')
  useApp.getState().openNote('note')
  useApp.getState().openSource(null)
  expect(useApp.getState()).toMatchObject({ view: 'library', sourceId: null, sourceReturn: null })
  useApp.getState().back()
  expect(useApp.getState()).toMatchObject({ view: 'notes', noteId: 'note', sourceId: 'source', sourceReturn: { view: 'library' } })
  useApp.getState().forward()
  expect(useApp.getState().view).toBe('library')
  useApp.getState().back()
  useApp.getState().openSource(null)
  expect(useApp.getState().view).toBe('library')
})
it('closing a source opened through a note reference keeps that note', () => {
  useApp.setState({ view: 'notes', noteId: 'original' })
  useApp.getState().openSource('source')
  useApp.getState().openSource(null)
  expect(useApp.getState()).toMatchObject({ view: 'notes', noteId: 'original', sourceId: null })
})
it('switching sources keeps the original return and restoring browser origin survives history', () => {
  useApp.setState({ view: 'notes', browserOpen: true, browserNote: 'note' })
  useApp.getState().openSource('first')
  useApp.getState().openSource('second')
  useApp.getState().openSource(null)
  expect(useApp.getState()).toMatchObject({ view: 'notes', browserOpen: true, browserNote: 'note', sourceId: null })
  useApp.getState().back()
  expect(useApp.getState().browserOpen).toBe(false)
  useApp.getState().forward()
  expect(useApp.getState().browserOpen).toBe(true)
})
