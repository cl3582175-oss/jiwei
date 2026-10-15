import { beforeEach, expect, it } from 'vitest'
import { useApp } from '../app'

beforeEach(() =>
  useApp.setState({
    view: 'today',
    noteId: null,
    sourceId: null,
    browserOpen: false,
    conversationId: null,
    chatProjectId: null,
    chatNewProjectId: null,
    chatMessageId: null,
    history: [{ view: 'today', noteId: null, sourceId: null }],
    historyIndex: 0
  })
)

it('keeps project home, unsent project chat, and conversations distinct in history', () => {
  const app = useApp.getState()
  app.openChatProject('project')
  expect(useApp.getState()).toMatchObject({ view: 'chat', chatProjectId: 'project', conversationId: null })
  app.startProjectConversation('project')
  expect(useApp.getState()).toMatchObject({ chatProjectId: null, chatNewProjectId: 'project', conversationId: null })
  app.openConversation('conversation')
  expect(useApp.getState()).toMatchObject({ conversationId: 'conversation', chatProjectId: null, chatNewProjectId: null })
  app.back()
  expect(useApp.getState()).toMatchObject({ conversationId: null, chatNewProjectId: 'project' })
  app.back()
  expect(useApp.getState()).toMatchObject({ conversationId: null, chatProjectId: 'project', chatNewProjectId: null })
  app.forward()
  expect(useApp.getState().chatNewProjectId).toBe('project')
})

it('search targets clear when starting an ordinary new conversation', () => {
  const app = useApp.getState()
  app.openConversation('conversation', 'message')
  expect(useApp.getState().chatMessageId).toBe('message')
  app.openConversation(null)
  expect(useApp.getState()).toMatchObject({ conversationId: null, chatProjectId: null, chatNewProjectId: null, chatMessageId: null })
})

it('restores project home after opening and closing a source', () => {
  const app = useApp.getState()
  app.openChatProject('project')
  app.openSource('source')
  app.openSource(null)
  expect(useApp.getState()).toMatchObject({ view: 'chat', chatProjectId: 'project', conversationId: null })
})
