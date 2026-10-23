// Adapted from shadcn/ui Marker (MIT). See ./LICENSE and docs/ai-elements.md.
import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

const variants = {
  default: '',
  separator:
    'before:mr-1 before:h-px before:min-w-0 before:flex-1 before:bg-border after:ml-1 after:h-px after:min-w-0 after:flex-1 after:bg-border',
  border: 'border-b border-border pb-2'
} as const

export function Marker({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: ComponentProps<'div'> & {
  variant?: keyof typeof variants
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="marker"
      data-variant={variant}
      className={cn(
        'group/marker relative flex min-h-4 w-full min-w-0 items-center gap-2 text-left text-xs text-muted [&_svg]:size-3.5',
        variants[variant],
        className
      )}
      {...props}
    />
  )
}

export function MarkerIcon({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="marker-icon"
      aria-hidden="true"
      className={cn('flex size-4 shrink-0 items-center justify-center', className)}
      {...props}
    />
  )
}

export function MarkerContent({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="marker-content"
      className={cn('min-w-0 wrap-break-word group-data-[variant=separator]/marker:flex-none', className)}
      {...props}
    />
  )
}
