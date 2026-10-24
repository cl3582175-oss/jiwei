// shadcn/ui AI Elements Inline Citation composition (MIT).
import type { ComponentProps } from 'react'
import { HoverCard } from 'radix-ui'
import { cn } from '@/lib/utils'

export function InlineCitation({ children, preview, title, ...props }: ComponentProps<'button'> & { preview: string; title: string }) {
  return (
    <HoverCard.Root openDelay={150} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <button type="button" data-slot="inline-citation" {...props}>
          {children}
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 w-[min(360px,85vw)] rounded-xl border border-border bg-surface p-3 text-xs text-fg shadow-float"
        >
          <p className="font-medium wrap-break-word">{title}</p>
          <p className="mt-2 max-h-48 overflow-y-auto leading-relaxed whitespace-pre-wrap text-muted">{preview}</p>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}

export function Source({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-slot="source"
      className={cn(
        'flex w-full min-w-0 items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-accent/50 outline-none',
        className
      )}
      {...props}
    />
  )
}
