import type { ReactNode } from 'react'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'

export const SIDEBAR_WIDTH = 300

/** 侧栏收展状态（存入设置，重启后保持） */
export function useSidebar(): { collapsed: boolean; toggle: () => void } {
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const collapsed = s?.sidebarCollapsed ?? false
  return { collapsed, toggle: () => update.mutate({ sidebarCollapsed: !collapsed }) }
}

/**
 * 可收起的侧栏容器：外层宽度在 300 ↔ 0 之间过渡，内层保持固定宽度，收起时内容不会被挤压变形；
 * 收起后设为 inert，键盘焦点与读屏不会进入隐藏区域。
 */
export function CollapsibleSidebar({
  children,
  className,
  forceCollapsed = false
}: {
  children: ReactNode
  className?: string
  /** 临时收起，不改用户设置 */
  forceCollapsed?: boolean
}) {
  const collapsed = useSidebar().collapsed || forceCollapsed
  return (
    <div
      data-collapsed={collapsed}
      className={cn(
        'h-full shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-[cubic-bezier(0.2,0.9,0.3,1)]',
        collapsed && 'opacity-0'
      )}
      style={{ width: collapsed ? 0 : SIDEBAR_WIDTH }}
      inert={collapsed}
    >
      <div className={cn('h-full', className)} style={{ width: SIDEBAR_WIDTH }}>
        {children}
      </div>
    </div>
  )
}
