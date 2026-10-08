import { useTranslation } from 'react-i18next'
import { Brain } from 'lucide-react'
import { PROVIDER_PRESETS, type Effort, type ProviderKind } from '@shared/ai'
import { cn } from '@/lib/utils'
import { Tip } from '@/components/ui/primitives'

/**
 * 思考强度选择：只显示当前服务商支持的档位。
 * 关闭 = 直接回答（最快、最省）；档位越高思考越深、越慢、费用越高。
 */
export function EffortPicker({
  kind,
  value,
  onChange,
  compact
}: {
  kind: ProviderKind
  value: Effort
  onChange: (e: Effort) => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const levels = PROVIDER_PRESETS[kind].efforts
  // 当前值不在支持范围时，显示为就近的档位
  const shown = levels.includes(value) ? value : (levels.find((l) => l !== 'off') ?? levels[0])
  return (
    <div
      role="radiogroup"
      aria-label={t('ai.effort')}
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-sunken p-0.5"
    >
      <Tip label={t('ai.effortHint')} side="top">
        <span className={cn('grid place-items-center text-subtle', compact ? 'size-6' : 'size-7')}>
          <Brain className="size-3.5" />
        </span>
      </Tip>
      {levels.map((l) => (
        <Tip key={l} label={t(`ai.effortTips.${l}`)} side="top">
          <button
            role="radio"
            aria-checked={shown === l}
            onClick={() => onChange(l)}
            className={cn(
              'rounded-md px-2.5 text-xs transition-all',
              compact ? 'h-6' : 'h-7',
              shown === l
                ? l === 'off'
                  ? 'bg-surface font-medium text-fg shadow-card'
                  : 'bg-accent font-medium text-accent-fg shadow-card'
                : 'text-muted hover:text-fg'
            )}
          >
            {t(`ai.efforts.${l}`)}
          </button>
        </Tip>
      ))}
    </div>
  )
}
