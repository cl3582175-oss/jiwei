// Adapted from shadcn/ui radix-nova (MIT), CLI 4.22.1. See LICENSE.shadcn.txt.
import { forwardRef, type ComponentRef, type ComponentPropsWithoutRef } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export const Switch = forwardRef<ComponentRef<typeof SwitchPrimitive.Root>, ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { variant?: 'default' | 'pill' }>(
  ({ className, variant = 'default', children, ...props }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      data-variant={variant}
      className={cn(
        'group/switch relative inline-flex shrink-0 cursor-pointer items-center border-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'pill' ? 'h-7 gap-1.5 rounded-lg bg-secondary px-2.5 text-xs text-secondary-foreground hover:bg-ui-accent data-[state=checked]:bg-foreground data-[state=checked]:text-background' : 'h-5 w-9 rounded-full bg-input data-[state=checked]:bg-primary',
        className
      )}
      {...props}
    >
      {variant === 'pill' ? children : <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-white shadow-card transition-transform data-[state=checked]:translate-x-[18px]"
      />}
    </SwitchPrimitive.Root>
  )
)
Switch.displayName = 'Switch'
