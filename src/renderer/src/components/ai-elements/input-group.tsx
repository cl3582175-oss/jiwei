// Adapted from shadcn/ui InputGroup, used by AI Elements Prompt Input (MIT).
// Jiwei retains its controlled input, attachment controller and IPC callbacks.
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function InputGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        'group/input-group relative flex w-full min-w-0 flex-col rounded-2xl border border-border bg-surface shadow-[var(--shadow-1)] transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft',
        className
      )}
      {...props}
    />
  )
}

export function InputGroupAddon({
  className,
  align = 'block-end',
  ...props
}: ComponentProps<'div'> & { align?: 'block-start' | 'block-end' }) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        'flex w-full min-w-0 flex-wrap items-center gap-1.5 px-2.5 py-2',
        align === 'block-start' ? 'order-first' : 'order-last',
        className
      )}
      {...props}
    />
  )
}

export function InputGroupTextarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="input-group-control"
      className={cn(
        'block max-h-[220px] min-h-[52px] w-full min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-3 text-sm leading-relaxed text-fg outline-none placeholder:text-subtle disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export function InputGroupTools({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="input-group-tools" className={cn('flex min-w-0 flex-1 flex-wrap items-center gap-1.5', className)} {...props} />
}

export function InputGroupInput({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      data-slot="input-group-control"
      className={cn(
        'h-9 min-w-0 flex-1 border-0 bg-transparent text-sm text-fg outline-none placeholder:text-subtle disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export function InputGroupButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button data-slot="input-group-button" className={cn('rounded-full', className)} {...props} />
}
