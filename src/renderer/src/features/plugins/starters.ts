import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import i18n from '@/i18n'

/** 起步卡里的引用写包内短 ID 时，补上插件名前缀，与注册表里的 ID（`插件名:ID`）对上 */
const qualify = (pluginId: string, ref: string): string => (ref.includes(':') ? ref : `${pluginId.split('@')[0]}:${ref}`)

/** 点击起步卡：主进程记录完成并返回导航动作；这里只负责预填和跳转，不发送、不运行 */
export async function runStarter(pluginId: string, starterId: string): Promise<void> {
  const action = await api.plugins.activateStarter(pluginId, starterId)
  const zh = i18n.language.startsWith('zh')
  const app = useApp.getState()
  app.setSettingsOpen(false)
  if (action.kind === 'chat') {
    useApp.setState({ starterIntent: { kind: 'chat', text: zh ? action.prompt.zh : action.prompt.en }, conversationId: null })
    app.setView('chat')
  } else if (action.kind === 'advisor') {
    useApp.setState({
      decisionId: null,
      starterIntent: {
        kind: 'advisor',
        framework: qualify(pluginId, action.framework),
        question: zh ? action.question.zh : action.question.en
      }
    })
    app.setView('advisor')
  } else if (action.kind === 'work') {
    useApp.setState({ starterIntent: { kind: 'work', template: qualify(pluginId, action.template) } })
    app.setView('works')
  } else {
    useApp.setState({ starterIntent: { kind: 'recipe', recipe: action.recipeRef ?? qualify(pluginId, action.recipe!) } })
    app.openSettings('tasks')
  }
}
