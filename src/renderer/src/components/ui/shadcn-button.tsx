// Adapted from shadcn/ui radix-nova (MIT), CLI 4.22.1. See LICENSE.shadcn.txt.
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'

const primary = 'bg-primary text-primary-foreground hover:brightness-110 active:brightness-95'
const danger = 'bg-destructive text-destructive-foreground hover:brightness-110 active:brightness-95'
export const buttonVariants = cva(
  'group/button inline-flex shrink-0 items-center justify-center rounded-md border-0 bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background,color,filter,opacity] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-45 aria-invalid:ring-2 aria-invalid:ring-destructive [&_svg]:pointer-events-none [&_svg:not([class*="size-"])]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: primary,
        primary,
        secondary: 'bg-secondary text-secondary-foreground hover:bg-ui-accent',
        outline: 'border border-border bg-surface text-foreground hover:bg-ui-accent',
        ghost: 'text-muted-foreground hover:bg-ui-accent hover:text-foreground',
        danger,
        destructive: 'bg-destructive/10 text-destructive hover:bg-destructive/20',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        auto: 'inline-block h-auto gap-1.5 border-0 p-0 align-middle whitespace-normal',
        default: 'h-[34px] gap-2 px-3.5',
        md: 'h-[34px] gap-2 px-3.5',
        sm: 'h-7 gap-1.5 px-2.5 text-xs',
        xs: 'h-6 gap-1 px-2 text-xs',
        lg: 'h-9 gap-2 px-4',
        icon: 'size-[34px]',
        'icon-sm': 'size-7',
        'icon-xs': 'size-6',
        'icon-lg': 'size-9'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', type = 'button', asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot.Root : 'button'
    return (
      <Comp
        ref={ref}
        {...(!asChild ? { type } : {})}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'
