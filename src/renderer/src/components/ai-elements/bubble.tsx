// Adapted from shadcn/ui Bubble (MIT). See ./LICENSE and docs/ai-elements.md.
// Use Jiwei's existing tokens and variant maps; no additional runtime package.
import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

const variants = {
  default: '*:data-[slot=bubble-content]:bg-accent *:data-[slot=bubble-content]:text-accent-fg',
  muted: '*:data-[slot=bubble-content]:bg-sunken *:data-[slot=bubble-content]:text-fg',
  outline: '*:data-[slot=bubble-content]:border-border *:data-[slot=bubble-content]:bg-surface',
  ghost:
    'max-w-full *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:border-0 *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0'
} as const

export function Bubble({
  variant = 'muted',
  align = 'start',
  className,
  ...props
}: ComponentProps<'div'> & {
  variant?: keyof typeof variants
  align?: 'start' | 'end'
}) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(
        'group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end',
        variants[variant],
        className
      )}
      {...props}
    />
  )
}

export function BubbleContent({ asChild = false, className, ...props }: ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      data-slot="bubble-content"
      className={cn(
        'w-fit max-w-full min-w-0 rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end',
        className
      )}
      {...props}
    />
  )
}
