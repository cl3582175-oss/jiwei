import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { DialogContent as Surface, DialogHeader, DialogTitle, DialogDescription } from './dialog'
import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip'
import {
  DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSubTrigger, DropdownMenuSubContent
} from './dropdown-menu'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent } from './empty'

export { Input } from './input'
export { TooltipProvider } from './tooltip'
export { Dialog, DialogTrigger, DialogClose } from './dialog'
export { DropdownMenu as Menu, DropdownMenuTrigger as MenuTrigger, DropdownMenuSub as MenuSub } from './dropdown-menu'

/** Compatibility at business entry points; all visuals come from the shared sources. */
export function Tip({ label, side = 'right', children }: {
  label: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
}) {
  return (
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  )
}

export function DialogContent({ title, description, children, className, hideClose }: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  className?: string
  hideClose?: boolean
}) {
  return (
    <Surface showCloseButton={!hideClose} className={cn('block p-6', className)}>
      <DialogHeader>
        <DialogTitle className="text-md font-semibold">{title}</DialogTitle>
        <DialogDescription className={cn(!description && 'sr-only')}>{description ?? title}</DialogDescription>
      </DialogHeader>
      {children}
    </Surface>
  )
}

export function MenuContent({ children, align = 'end', className, ...props }: ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent align={align} sideOffset={6} className={cn('min-w-[180px]', className)} {...props}>
      <DropdownMenuGroup>{children}</DropdownMenuGroup>
    </DropdownMenuContent>
  )
}
export function MenuItem({ danger, variant, ...props }: ComponentProps<typeof DropdownMenuItem> & { danger?: boolean }) {
  return <DropdownMenuItem variant={danger ? 'destructive' : variant} {...props} />
}
export const MenuSeparator = DropdownMenuSeparator
export const MenuLabel = DropdownMenuLabel
export const MenuSubTrigger = DropdownMenuSubTrigger
export function MenuSubContent({ children, onEscapeKeyDown, ...props }: ComponentProps<typeof DropdownMenuSubContent>) {
  return <DropdownMenuSubContent {...props} onEscapeKeyDown={(event) => { event.stopPropagation(); onEscapeKeyDown?.(event) }}><DropdownMenuGroup>{children}</DropdownMenuGroup></DropdownMenuSubContent>
}
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd data-slot="kbd" className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-secondary px-1 font-sans text-2xs text-muted-foreground', className)}>{children}</kbd>
}
export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <Empty className="h-full border-0 px-8">
      <EmptyHeader>
        <div className="mb-4 text-subtle">{icon}</div>
        <EmptyTitle className="text-md">{title}</EmptyTitle>
        {hint && <EmptyDescription className="max-w-[340px] text-sm">{hint}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
