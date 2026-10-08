import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * 印章标志：朱文方印，篆刻式不规则边缘（SVG 噪点位移），印中一个“微”字。
 * 颜色跟随强调色。
 */
export function Logo({ size = 34, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cn('shrink-0 select-none', className)} role="img" aria-label="积微">
      <defs>
        <filter id={`rough-${id}`} x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" />
        </filter>
      </defs>
      <g filter={`url(#rough-${id})`}>
        <rect x="3" y="3" width="58" height="58" rx="9" fill="var(--accent)" />
        <rect x="8" y="8" width="48" height="48" rx="5" fill="none" stroke="var(--accent-fg)" strokeOpacity="0.55" strokeWidth="1.4" />
      </g>
      <text
        x="32"
        y="33"
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--accent-fg)"
        fontFamily="var(--font-serif)"
        fontWeight="700"
        fontSize="34"
      >
        微
      </text>
    </svg>
  )
}
