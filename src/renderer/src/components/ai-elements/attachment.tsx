// Adapted from shadcn/ui Attachment (MIT). See ./LICENSE and docs/ai-elements.md.
import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

const sizes = {
  default: 'gap-2 px-2.5 py-2 text-sm',
  sm: 'gap-2 px-2 py-1.5 text-xs',
  xs: 'gap-1.5 rounded-lg px-1.5 py-1 text-xs'
} as const

export function Attachment({
  className,
  state = 'done',
  size = 'default',
  orientation = 'horizontal',
  ...props
}: ComponentProps<'div'> & {
  state?: 'idle' | 'uploading' | 'processing' | 'error' | 'done'
  size?: keyof typeof sizes
  orientation?: 'horizontal' | 'vertical'
}) {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      data-orientation={orientation}
      className={cn(
        'group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 rounded-xl border border-border bg-surface text-fg transition-colors focus-within:ring-2 focus-within:ring-accent-soft data-[state=error]:border-danger/40 data-[state=idle]:border-dashed',
        sizes[size],
        orientation === 'vertical' ? 'w-28 flex-col' : 'items-center',
        className
      )}
      {...props}
    />
  )
}

export function AttachmentMedia({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="attachment-media"
      className={cn(
        'flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sunken group-data-[size=sm]/attachment:size-8 [&_svg]:size-5',
        className
      )}
      {...props}
    />
  )
}

export function AttachmentContent({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="attachment-content" className={cn('max-w-full min-w-0 flex-1 leading-tight', className)} {...props} />
}

export function AttachmentTitle({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="attachment-title" className={cn('block max-w-full min-w-0 truncate font-medium', className)} {...props} />
}

export function AttachmentDescription({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="attachment-description"
      className={cn(
        'mt-0.5 block max-w-full min-w-0 truncate text-2xs text-muted group-data-[state=error]/attachment:text-danger',
        className
      )}
      {...props}
    />
  )
}

export function AttachmentActions({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="attachment-actions" className={cn('relative flex shrink-0 items-center', className)} {...props} />
}

export function AttachmentTrigger({ asChild = false, className, ...props }: ComponentProps<'button'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      type={asChild ? undefined : 'button'}
      data-slot="attachment-trigger"
      className={cn('min-w-0 outline-none', className)}
      {...props}
    />
  )
}
