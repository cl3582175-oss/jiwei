import { useTranslation } from 'react-i18next'
import { useApp } from '@/store/app'

/** 只读定义与用户数据的来源都跳到同一个已安装插件入口。 */
export function PluginSourceLabel({ pluginId, onNavigate }: { pluginId?: string | null; onNavigate?: () => void }) {
  const { t } = useTranslation()
  if (!pluginId) return null
  return (
    <button
      type="button"
      className="max-w-full truncate rounded bg-accent-soft px-1.5 py-0.5 text-2xs text-accent"
      title={`${t('plugins.manage')} · ${pluginId}`}
      onClick={(e) => {
        e.stopPropagation()
        onNavigate?.()
        useApp.setState({ settingsOpen: true, settingsTab: 'plugins', settingsPluginId: pluginId })
      }}
    >
      {pluginId.split('@')[0]}
    </button>
  )
}
