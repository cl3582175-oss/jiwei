// shadcn/ui AI Elements Model Selector: anchored Popover + cmdk composition (MIT).
import type { ComponentProps } from 'react'
import { Command } from 'cmdk'
import { Search } from 'lucide-react'
import { Popover } from 'radix-ui'
import { cn } from '@/lib/utils'

export const ModelSelector = Popover.Root
export const ModelSelectorTrigger = Popover.Trigger

export function ModelSelectorContent({ children, title, className, ...props }: ComponentProps<typeof Popover.Content> & { title: string }) {
  return (
    <Popover.Portal>
      <Popover.Content
        data-slot="model-selector-content"
        aria-label={title}
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          'z-50 w-[min(320px,calc(100vw-24px))] max-h-[var(--radix-popover-content-available-height)] overflow-hidden rounded-xl border border-border bg-surface p-2 text-fg shadow-float outline-none data-[state=open]:animate-[pop-in_140ms_ease-out]',
          className
        )}
        {...props}
      >
        <Command data-slot="model-selector" loop>
          {children}
        </Command>
      </Popover.Content>
    </Popover.Portal>
  )
}

export function ModelSelectorInput(props: ComponentProps<typeof Command.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border py-2">
      <Search aria-hidden="true" className="size-4 text-subtle" />
      <Command.Input className="h-9 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle" {...props} />
    </div>
  )
}

export function ModelSelectorList({ className, ...props }: ComponentProps<typeof Command.List>) {
  return (
    <Command.List
      className={cn('mt-2 max-h-[min(50vh,360px,calc(var(--radix-popover-content-available-height)-72px))] overflow-y-auto', className)}
      {...props}
    />
  )
}

export function ModelSelectorGroup(props: ComponentProps<typeof Command.Group>) {
  return (
    <Command.Group
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-subtle"
      {...props}
    />
  )
}

export function ModelSelectorItem({ className, ...props }: ComponentProps<typeof Command.Item>) {
  return (
    <Command.Item
      className={cn(
        'flex min-w-0 cursor-default items-center gap-2 rounded-lg px-3 py-2.5 text-sm outline-none data-[selected=true]:bg-sunken [&_svg]:size-4',
        className
      )}
      {...props}
    />
  )
}

export const ModelSelectorEmpty = Command.Empty
