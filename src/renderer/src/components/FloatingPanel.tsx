import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 层级 1：浮在桌面上的圆角面板。
 * 外层留出 8px 桌面边距（可拖动窗口），面板本身不可拖动；面板内的标题栏可单独设为可拖动。
 */
export function FloatingPanel({ children, className, flushLeft }: { children: ReactNode; className?: string; flushLeft?: boolean }) {
  return (
    <div className={cn('drag h-full min-w-0 flex-1 py-2 pr-2', !flushLeft && 'pl-2')}>
      <div className={cn('panel no-drag relative h-full', className)}>{children}</div>
    </div>
  )
}
