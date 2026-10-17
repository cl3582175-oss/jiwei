import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../../store/app'
import { currentPanelPage, getPanel, useAssist } from '../store'

beforeEach(() => {
  useApp.setState({ view: 'notes', browserOpen: false, sourceId: null, sourceProjectId: null, sourceReaderPending: false })
  useAssist.setState({ panels: {}, toolbar: null, card: null })
})
afterEach(() => vi.unstubAllGlobals())
describe('page workspace panels', () => {
  it('keeps open, pin, conversation and draft independently for each page', () => {
    useAssist.getState().setPanel({ panelOpen: true, panelPinned: true, panelConversationId: 'notes-chat', panelDraft: 'notes draft' })
    useApp.setState({ view: 'today' })
    expect(getPanel()).toMatchObject({ open: false, pinned: false, conversationId: null, draft: null })
    useAssist.getState().setPanel({ panelOpen: true, panelConversationId: 'today-chat' })
    useApp.setState({ view: 'notes' })
    expect(getPanel()).toMatchObject({ open: true, pinned: true, conversationId: 'notes-chat', draft: 'notes draft' })
    useAssist.getState().setPanel({ panelOpen: !getPanel().open })
    expect(getPanel('today').open).toBe(true)
  })
  it('uses a distinct browser workspace and clears transient selections on every page change', () => {
    useAssist.getState().setPanel({ panelOpen: true })
    const anchor = { parentType: 'note' as const, parentId: 'n', kind: 'note-text' as const, quote: 'q' }
    useAssist.getState().showToolbar({ anchor, rect: { x: 0, y: 0, w: 1, h: 1 } })
    useAssist.getState().openCard({ anchor, rect: { x: 0, y: 0, w: 1, h: 1 }, action: 'ask', conversationId: null, question: '' })
    useApp.setState({ browserOpen: true })
    expect(currentPanelPage()).toBe('browser')
    expect(getPanel().open).toBe(false)
    expect(useAssist.getState()).toMatchObject({ toolbar: null, card: null })
    useApp.setState({ browserOpen: false, noteId: 'another' })
    expect(getPanel().open).toBe(true)
  })
  it('binds an async send completion to its originating page', () => {
    const page = currentPanelPage()
    useApp.setState({ view: 'today' })
    useAssist.getState().setPanel({ panelConversationId: 'completed' }, page)
    expect(getPanel().conversationId).toBeNull()
    expect(getPanel('notes').conversationId).toBe('completed')
  })
  it('keeps reader history separate while carrying only the note panel preference', () => {
    useAssist.getState().setPanel({ panelOpen: true, panelPinned: true, panelConversationId: 'notes-chat', panelDraft: 'notes draft' })
    useApp.setState({ sourceId: 'private-file', sourceReaderPending: true })
    expect(getPanel()).toMatchObject({ open: true, pinned: true, conversationId: null, draft: null })
    useApp.setState({ sourceProjectId: 'project', sourceReaderPending: false })
    expect(getPanel()).toMatchObject({ open: true, pinned: true, conversationId: null, draft: null })
    useApp.setState({ browserOpen: true })
    expect(getPanel()).toMatchObject({ open: false, pinned: false, conversationId: null, draft: null })
    useApp.setState({ browserOpen: false, sourceId: null, sourceProjectId: null })
    expect(getPanel()).toMatchObject({ open: true, pinned: true, conversationId: 'notes-chat', draft: 'notes draft' })
  })
  it('revokes the old reader conversation before a new chat loses its identity', async () => {
    const releaseReader = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { jiwei: { chat: { releaseReader } } })
    useApp.setState({ sourceId: 'private-file', sourceProjectId: 'project' })
    useAssist.getState().setPanel({ panelConversationId: 'old-reader-chat' })
    useAssist.getState().setPanel({ panelConversationId: null })
    useApp.getState().openSource(null)
    expect(releaseReader).toHaveBeenCalledWith('old-reader-chat')
  })
})
