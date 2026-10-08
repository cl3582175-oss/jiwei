import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { Dialog as D, DropdownMenu as M, Tooltip as T } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ——— Input ——— */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-[34px] w-full rounded-md border border-border bg-surface px-3 text-sm text-fg placeholder:text-subtle transition-colors outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

/* ——— Tooltip ——— */
export function Tip({
  label,
  side = 'right',
  children
}: {
  label: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
}) {
  return (
    <T.Root delayDuration={350}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={8}
          className="z-50 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-float animate-[fade-in_120ms_ease-out]"
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
export const TooltipProvider = T.Provider

/* ——— Dialog ——— */
export const Dialog = D.Root
export const DialogTrigger = D.Trigger
export const DialogClose = D.Close

export function DialogContent({
  title,
  description,
  children,
  className,
  hideClose
}: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  className?: string
  hideClose?: boolean
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
      <D.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-float outline-none data-[state=open]:animate-[dialog-in_200ms_cubic-bezier(0.2,0.9,0.3,1)]',
          className
        )}
      >
        <D.Title className="text-md font-semibold text-fg">{title}</D.Title>
        {description ? (
          <D.Description className="mt-1.5 text-sm leading-relaxed text-muted">{description}</D.Description>
        ) : (
          <D.Description className="sr-only">{title}</D.Description>
        )}
        {children}
        {!hideClose && (
          <D.Close className="absolute top-4 right-4 rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-fg">
            <X className="size-4" />
          </D.Close>
        )}
      </D.Content>
    </D.Portal>
  )
}

/* ——— Dropdown Menu ——— */
export const Menu = M.Root
export const MenuTrigger = M.Trigger

export function MenuContent({
  children,
  align = 'end',
  className
}: {
  children: ReactNode
  align?: 'start' | 'end' | 'center'
  className?: string
}) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        className={cn(
          'z-50 min-w-[180px] rounded-lg border border-border bg-surface p-1 shadow-float outline-none data-[state=open]:animate-[pop-in_140ms_ease-out]',
          className
        )}
      >
        {children}
      </M.Content>
    </M.Portal>
  )
}

const itemCls =
  'flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm text-fg outline-none select-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:text-muted'

export function MenuItem({ children, danger, ...props }: M.DropdownMenuItemProps & { danger?: boolean }) {
  return (
    <M.Item className={cn(itemCls, danger && 'text-danger [&_svg]:text-danger data-[highlighted]:bg-danger-soft')} {...props}>
      {children}
    </M.Item>
  )
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-border" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-subtle uppercase">{children}</M.Label>
}

export const MenuSub = M.Sub
export function MenuSubTrigger({ children }: { children: ReactNode }) {
  return <M.SubTrigger className={cn(itemCls, 'data-[state=open]:bg-surface-hover')}>{children}</M.SubTrigger>
}
export function MenuSubContent({ children }: { children: ReactNode }) {
  return (
    <M.Portal>
      <M.SubContent
        sideOffset={4}
        className="z-50 max-h-[50vh] min-w-[160px] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-float"
      >
        {children}
      </M.SubContent>
    </M.Portal>
  )
}

/* ——— Kbd ——— */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-sunken px-1 font-sans text-2xs text-subtle',
        className
      )}
    >
      {children}
    </kbd>
  )
}

/* ——— Empty state ——— */
export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="mb-5 grid size-16 place-items-center rounded-2xl border border-border bg-surface text-subtle shadow-card [&_svg]:size-7">
        {icon}
      </div>
      <p className="text-md font-medium text-fg">{title}</p>
      {hint && <p className="mt-1.5 max-w-[340px] text-sm leading-relaxed text-muted">{hint}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
