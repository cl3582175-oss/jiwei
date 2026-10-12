import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * 标志“积水成渊”：一滴金色的水落入器皿，器中水位层层积高。与应用图标（build/icon.*，
 * 源文件 design/icon/jiwei-icon.svg）同形；底色跟随强调色。
 */
export function Logo({ size = 34, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={cn('shrink-0 select-none', className)} role="img" aria-label="积微">
      <defs>
        <linearGradient id={`gold-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe3a0" />
          <stop offset="1" stopColor="#e2a740" />
        </linearGradient>
        <linearGradient id={`hi-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".28" />
          <stop offset=".45" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".18" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22.4" fill="var(--accent)" />
      <rect width="100" height="100" rx="22.4" fill={`url(#hi-${id})`} />
      <path d="M22 36v22a28 22 0 0 0 56 0V36" fill="none" stroke="#f4efe4" strokeWidth="9" strokeLinecap="round" />
      <path d="M31 58h38a19 14 0 0 1-38 0Z" fill="#f4efe4" />
      <rect x="31" y="47" width="38" height="7" rx="3.5" fill="#f4efe4" fillOpacity=".6" />
      <rect x="31" y="38" width="38" height="5.5" rx="2.75" fill="#f4efe4" fillOpacity=".3" />
      <path d="M50 13c4.5 5.5 6.5 8.6 6.5 11.2a6.5 6.5 0 0 1-13 0c0-2.6 2-5.7 6.5-11.2Z" fill={`url(#gold-${id})`} />
    </svg>
  )
}
