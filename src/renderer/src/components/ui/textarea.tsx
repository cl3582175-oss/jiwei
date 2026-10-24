// Adapted from shadcn/ui radix-nova (MIT), CLI 4.22.1. See LICENSE.shadcn.txt.
import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[34px] w-full rounded-lg border border-transparent bg-surface text-fg px-2.5 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:bg-sunken disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50  md:text-sm    ",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
