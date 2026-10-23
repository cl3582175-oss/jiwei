// shadcn/ui AI Elements Checkpoint composition (MIT). Uses existing saved revisions.
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Checkpoint({ className, selected = false, ...props }: ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      data-slot="checkpoint"
      aria-pressed={selected}
      className={cn(
        'relative w-full rounded-xl border border-transparent px-3 py-3 text-left transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent/50',
        selected && 'border-border bg-surface shadow-[var(--shadow-1)]',
        className
      )}
      {...props}
    />
  )
}
