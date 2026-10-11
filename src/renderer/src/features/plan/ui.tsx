import type { ReactNode } from 'react'
import { Dialog as D } from 'radix-ui'

export const field =
  'mt-1 block w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent'
export function PlanDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(92vw,680px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-float outline-none">
          <D.Title className="font-serif text-lg font-semibold text-fg">{title}</D.Title>
          <D.Description className="sr-only">{title}</D.Description>
          <div className="mt-4 space-y-4">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
