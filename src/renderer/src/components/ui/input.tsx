// Adapted from shadcn/ui radix-nova (MIT), CLI 4.22.1. See LICENSE.shadcn.txt.
import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[34px] w-full min-w-0 rounded-lg border border-transparent bg-surface px-3 text-fg py-1 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:bg-sunken disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50  md:text-sm    ",
        className
      )}
      {...props}
    />
  )
}

export { Input }
