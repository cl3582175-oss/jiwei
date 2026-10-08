import { cn } from '@/lib/utils'

/** 印章式标志：方印中一个“微”字 */
export function Logo({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <div
      className={cn('grid place-items-center rounded-[9px] bg-accent text-accent-fg shadow-card select-none', className)}
      style={{ width: size, height: size }}
    >
      <span className="font-serif font-bold" style={{ fontSize: size * 0.56, lineHeight: 1 }}>
        微
      </span>
    </div>
  )
}
