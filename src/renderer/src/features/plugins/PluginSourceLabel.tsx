import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'

/** 插件 ID → 给人看的名字（已按界面语言本地化）。插件已卸载时退回 ID 里的名字。 */
export function usePluginNames(): (pluginId?: string | null) => string {
  const { data = [] } = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list() })
  return (pluginId) => {
    if (!pluginId) return ''
    const p = data.find((x) => x.id === pluginId)
    return p?.manifest.displayName ?? p?.manifest.name ?? pluginId.split('@')[0]
  }
}

/** 只读定义与用户数据的来源都跳到同一个已安装插件入口。 */
export function PluginSourceLabel({ pluginId, onNavigate }: { pluginId?: string | null; onNavigate?: () => void }) {
  const { t } = useTranslation()
  const nameOf = usePluginNames()
  if (!pluginId) return null
  return (
    <button
      type="button"
      className="max-w-full truncate rounded bg-accent-soft px-1.5 py-0.5 text-2xs text-accent"
      title={t('plugins.manage')}
      onClick={(e) => {
        e.stopPropagation()
        onNavigate?.()
        useApp.setState({ settingsOpen: true, settingsTab: 'plugins', settingsPluginId: pluginId })
      }}
    >
      {nameOf(pluginId)}
    </button>
  )
}
