// shadcn/ui AI Elements Plan / Task / Queue compositions (MIT).
import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

export function Plan({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="plan" className={cn('min-w-0 rounded-xl border border-border bg-surface p-3', className)} {...props} />
}

export function PlanContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="plan-content" className={cn('flex min-w-0 flex-col gap-2', className)} {...props} />
}

export function Task({
  asChild = false,
  className,
  state = 'pending',
  ...props
}: ComponentProps<'div'> & { asChild?: boolean; state?: string }) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="task"
      data-task-state={state}
      className={cn(
        'min-w-0 rounded-lg border border-border bg-surface p-3 text-sm text-fg data-[task-state=done]:bg-sunken/60 data-[task-state=running]:border-accent/40 data-[task-state=failed]:border-danger/30',
        className
      )}
      {...props}
    />
  )
}

export function Queue({ className, ...props }: ComponentProps<'section'>) {
  return <section data-slot="queue" className={cn('min-w-0', className)} {...props} />
}

export function QueueList({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="queue-list" role="list" className={cn('flex min-w-0 flex-col gap-1.5', className)} {...props} />
}

export function QueueItem({ className, state, ...props }: ComponentProps<'div'> & { state: string }) {
  return (
    <Task
      data-slot="queue-item"
      role="listitem"
      state={state}
      className={cn('flex items-center gap-2.5 px-2 py-2', className)}
      {...props}
    />
  )
}
