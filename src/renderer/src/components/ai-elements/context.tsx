// shadcn/ui AI Elements Context composition (MIT), using only measured app data.
import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

export function Context({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="context" role="group" className={cn('flex min-w-0 flex-wrap items-center gap-1.5', className)} {...props} />
}

export function ContextTag({
  asChild = false,
  inactive = false,
  className,
  ...props
}: ComponentProps<'span'> & { asChild?: boolean; inactive?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span'
  return (
    <Comp
      data-slot="context-tag"
      data-inactive={inactive}
      className={cn(
        'inline-flex min-h-6 max-w-full min-w-0 items-center gap-1 rounded-full border border-border bg-surface px-2 text-2xs text-muted [&_svg]:size-3 [&_svg]:shrink-0 data-[inactive=true]:border-dashed data-[inactive=true]:bg-transparent data-[inactive=true]:text-subtle data-[inactive=true]:line-through',
        className
      )}
      {...props}
    />
  )
}

export function ContextUsage({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="context-usage" className={cn('min-w-0 text-xs text-muted tabular-nums wrap-break-word', className)} {...props} />
}
