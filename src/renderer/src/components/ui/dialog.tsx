// Adapted from shadcn/ui radix-nova (MIT), CLI 4.22.1. See LICENSE.shadcn.txt.
import { useTranslation } from 'react-i18next'
import { XIcon } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/utils'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { Button } from '@/components/ui/shadcn-button'
function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  motion = 'enter',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay> & { motion?: 'both' | 'enter' | 'none' }) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-40 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs',
        motion !== 'none' && 'data-open:animate-in data-open:fade-in-0',
        motion === 'both' && 'data-closed:animate-out data-closed:fade-out-0',
        className
      )}
      {...props}
    />
  )
}

/** Non-portalled source surface for existing anchored layouts and the stable expanded mount. */
function DialogSurface({
  className,
  placement = 'custom',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { placement?: 'center' | 'custom' | 'expanded' }) {
  return (
    <DialogPrimitive.Content
      data-ui-overlay="dialog"
      data-slot="dialog-content"
      className={cn(
        'fixed z-50 rounded-xl bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none',
        placement === 'center' &&
          'top-1/2 left-1/2 grid w-[min(92vw,440px)] max-w-none -translate-x-1/2 -translate-y-1/2 gap-4 p-4 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
        placement === 'expanded' && 'expanded-surface',
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  placement = 'center',
  ...props
}: React.ComponentProps<typeof DialogSurface> & { showCloseButton?: boolean }) {
  const { t } = useTranslation()
  return (
    <DialogPortal>
      <DialogOverlay motion={placement === 'center' ? 'both' : 'enter'} />
      <DialogSurface placement={placement} className={className} {...props}>
        {children}
        {showCloseButton && (
          <DialogClose asChild>
            <Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" aria-label={t('common.close')}>
              <XIcon />
            </Button>
          </DialogClose>
        )}
      </DialogSurface>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        '-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-ui-muted/50 p-4 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="secondary">{t('common.close')}</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title data-slot="dialog-title" className={cn('font-serif text-base leading-none font-medium', className)} {...props} />
  )
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  DialogSurface
}

/** Compatibility names only: the same source components own style and focus. */
export const DialogParts = {
  Root: Dialog,
  Trigger: DialogTrigger,
  Close: DialogClose,
  Portal: DialogPortal,
  Overlay: DialogOverlay,
  Content: DialogSurface,
  Title: DialogTitle,
  Description: DialogDescription
}
