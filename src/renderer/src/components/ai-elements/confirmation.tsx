// shadcn/ui AI Elements Confirmation composition (MIT); existing actions own all decisions.
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Confirmation({ className, state = 'pending', ...props }: ComponentProps<'div'> & { state?: string }) {
  return (
    <div
      data-slot="confirmation"
      data-state={state}
      role="group"
      className={cn('min-w-0 rounded-xl border border-accent/30 bg-accent-soft/40 p-4 text-sm text-fg shadow-[var(--shadow-1)]', className)}
      {...props}
    />
  )
}

export function ConfirmationTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="confirmation-title"
      className={cn('flex min-w-0 items-center gap-2 text-xs font-medium text-accent [&_svg]:size-4 [&_svg]:shrink-0', className)}
      {...props}
    />
  )
}

export function ConfirmationActions({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="confirmation-actions" className={cn('mt-3 flex flex-wrap items-center gap-2', className)} {...props} />
}
