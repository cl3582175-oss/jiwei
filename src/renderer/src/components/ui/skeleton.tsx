// Adapted from shadcn/ui radix-nova (MIT), CLI 4.22.1. See LICENSE.shadcn.txt.
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-ui-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
