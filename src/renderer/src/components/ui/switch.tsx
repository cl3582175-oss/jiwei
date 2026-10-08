import { Switch as S } from 'radix-ui'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: S.SwitchProps) {
  return (
    <S.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-default items-center rounded-full border border-transparent bg-border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 data-[state=checked]:bg-accent',
        className
      )}
      {...props}
    >
      <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-card transition-transform data-[state=checked]:translate-x-[18px]" />
    </S.Root>
  )
}
