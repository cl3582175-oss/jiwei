import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog as D } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TINTS, type Tint } from '@/lib/tint'

export const field =
  'mt-1 block w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent'

const WIDTH = { sm: 'w-[min(92vw,460px)]', md: 'w-[min(92vw,560px)]', lg: 'w-[min(94vw,760px)]' } as const

/**
 * 计划相关的对话框：标题 + 右上角关闭 + 内容 + 底部操作条（左侧放危险操作，右侧放主操作）。
 * v0.7.x 审查后统一：不再在内容末尾放一个孤立的“关闭”文字按钮。
 */
export function PlanDialog({
  title,
  description,
  children,
  footer,
  size = 'md',
  onClose,
  testId
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  size?: keyof typeof WIDTH
  onClose: () => void
  testId?: string
}) {
  const { t } = useTranslation()
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_140ms_ease-out]" />
        <D.Content
          data-testid={testId}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-surface shadow-float outline-none data-[state=open]:animate-[pop-in_160ms_ease-out]',
            WIDTH[size]
          )}
        >
          <div className="flex shrink-0 items-start gap-3 px-6 pt-5">
            <div className="min-w-0 flex-1">
              <D.Title className="truncate font-serif text-lg font-semibold text-fg">{title}</D.Title>
              <D.Description className={description ? 'mt-1 text-xs leading-relaxed text-muted' : 'sr-only'}>
                {description ?? title}
              </D.Description>
            </div>
            <D.Close
              aria-label={t('common.close')}
              className="-mr-2 grid size-8 shrink-0 place-items-center rounded-lg text-subtle transition-colors hover:bg-surface-hover hover:text-fg"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-4 pb-5">{children}</div>
          {footer && <div className="flex shrink-0 items-center gap-2 border-t border-border/70 px-6 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 分段切换（周 / 月等），与用量看板的时间范围切换一致 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="no-drag inline-flex rounded-lg bg-sunken p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-md px-3 text-xs transition-colors',
            value === o.value ? 'bg-surface text-fg shadow-[var(--shadow-1)]' : 'text-muted hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 粉彩色板（方向、订阅的颜色） */
export function TintPicker({ value, onChange, label }: { value: string | null | undefined; onChange: (v: Tint) => void; label: string }) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {TINTS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={t(`tints.${c}`)}
          title={t(`tints.${c}`)}
          data-tint={c}
          onClick={() => onChange(c)}
          className={cn(
            'grid size-7 place-items-center rounded-full bg-[var(--tint)] ring-offset-2 ring-offset-surface transition-[box-shadow,transform] hover:scale-105',
            value === c && 'ring-2 ring-[var(--tint-ink)]'
          )}
        >
          <span className="size-2.5 rounded-full bg-[var(--tint-ink)]" />
        </button>
      ))}
    </div>
  )
}

/** 小时数（保留到 0.5） */
const hours = (minutes: number): string => String(Math.round((minutes / 60) * 2) / 2)

/** 按星期几分配可投入时间（以小时显示，内部存分钟）：周一到周日一行，右侧显示合计 */
export function WeekdayHours({ value, onChange, label }: { value: number[]; onChange: (v: number[]) => void; label: string }) {
  const { t } = useTranslation()
  const total = value.reduce((a, b) => a + b, 0)
  return (
    <div role="group" aria-label={label}>
      <div className="grid grid-cols-7 gap-1.5">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <label key={d} className="block text-center text-[11px] text-muted">
            {t(`plan.days.${d}`)}
            <input
              aria-label={t(`plan.days.${d}`)}
              inputMode="decimal"
              className="mt-1 block h-9 w-full min-w-0 rounded-lg border border-border bg-surface text-center text-sm text-fg tabular-nums outline-none focus:border-accent"
              value={hours(value[d])}
              onChange={(e) => {
                const h = Number(e.target.value.replace(/[^\d.]/g, ''))
                if (Number.isFinite(h)) onChange(value.map((v, i) => (i === d ? Math.min(1440, Math.round(h * 60)) : v)))
              }}
            />
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-right text-2xs text-subtle tabular-nums">{t('plan.weeklyTotal', { hours: hours(total) })}</p>
    </div>
  )
}

/** 每周总时数按“工作日少、周末多”拆分到每一天（分钟，15 分钟为单位） */
export function splitWeekly(weeklyMinutes: number): number[] {
  const unit = weeklyMinutes / 9 // 工作日各 1 份、周末各 2 份
  const round = (m: number): number => Math.round(m / 15) * 15
  return [0, 1, 2, 3, 4, 5, 6].map((d) => round(d === 0 || d === 6 ? unit * 2 : unit))
}
