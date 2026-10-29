// shadcn/ui AI Elements reasoning/tool/sources composition, adapted to existing Radix.
import type { ComponentProps, ReactNode } from 'react'
import { Collapsible } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Marker, MarkerContent, MarkerIcon } from './marker'

export function TraceLine({ className, status, ...props }: ComponentProps<'span'> & { status?: string }) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        'flex w-full min-w-0 items-start gap-2 text-xs text-muted data-[status=error]:text-danger data-[status=waiting]:opacity-70',
        className
      )}
      {...props}
    />
  )
}

export function Trace({ className, ...props }: ComponentProps<typeof Collapsible.Root>) {
  return <Collapsible.Root data-slot="trace" className={cn('min-w-0', className)} {...props} />
}

export function TraceTrigger({ icon, children, className, ...props }: ComponentProps<typeof Collapsible.Trigger> & { icon: ReactNode }) {
  return (
    <Collapsible.Trigger asChild {...props}>
      <Marker
        asChild
        className={cn(
          'w-fit max-w-full rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 outline-none',
          className
        )}
      >
        <button type="button" className="group/trace-trigger">
          <MarkerIcon>{icon}</MarkerIcon>
          <MarkerContent>{children}</MarkerContent>
          <ChevronRight aria-hidden="true" className="shrink-0 transition-transform group-aria-expanded/trace-trigger:rotate-90" />
        </button>
      </Marker>
    </Collapsible.Trigger>
  )
}

export function TraceContent({ className, ...props }: ComponentProps<typeof Collapsible.Content>) {
  return (
    <Collapsible.Content
      data-slot="trace-content"
      className={cn('mt-2 ml-3 min-w-0 border-l border-border pl-4 text-xs leading-relaxed text-muted', className)}
      {...props}
    />
  )
}
