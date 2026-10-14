import type { TimelineData } from '@shared/embeds/visuals'
import { cn } from '@/lib/utils'
export function TimelineBox({
  data: d,
  onAnchorClick
}: {
  data: TimelineData
  onAnchorClick?: (anchor: NonNullable<TimelineData['events'][number]['anchor']>) => void
}) {
  return (
    <div className="px-5 py-4">
      {d.title && <p className="mb-3 text-center font-serif text-sm font-semibold text-fg">{d.title}</p>}
      <ol className="timeline">
        {d.events.map((e, i) => (
          <li key={i} className="timeline-item">
            <span className="timeline-date">{e.date}</span>
            <span className="timeline-dot" />
            <div className="min-w-0">
              <p
                className={cn('text-sm font-medium text-fg', e.anchor && 'cursor-pointer hover:text-accent')}
                onClick={() => e.anchor && onAnchorClick?.(e.anchor)}
              >
                {e.title}
              </p>
              {e.detail && <p className="mt-0.5 text-xs leading-relaxed text-muted">{e.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
