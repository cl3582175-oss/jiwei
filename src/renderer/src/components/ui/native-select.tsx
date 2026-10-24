// Adapted from shadcn/ui radix-nova (MIT), CLI 4.22.1. See LICENSE.shadcn.txt.
// Preserve native select size, className and ref semantics; no layout wrapper.
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'h-[34px] min-w-0 max-w-full rounded-md border border-transparent bg-surface px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:bg-sunken disabled:cursor-not-allowed disabled:opacity-50 ',
        className
      )}
      {...props}
    />
  )
}
export function NativeSelectOption({ className, ...props }: ComponentProps<'option'>) {
  return <option data-slot="native-select-option" className={cn('bg-surface text-foreground', className)} {...props} />
}
export function NativeSelectOptGroup({ className, ...props }: ComponentProps<'optgroup'>) {
  return <optgroup data-slot="native-select-optgroup" className={cn('bg-surface text-foreground', className)} {...props} />
}
