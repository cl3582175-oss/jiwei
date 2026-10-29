import { useTranslation } from 'react-i18next'
import { Brain, Check, ChevronDown } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { normalizeEffort, resolveModelPolicy, type Effort } from '@shared/ai'
import type { ProviderInfo } from '@shared/types'
import { cn } from '@/lib/utils'
import { Tip, Menu, MenuTrigger, MenuContent, MenuLabel } from '@/components/ui/primitives'
import { Button } from '@/components/ui/button'

/**
 * 思考强度选择：与发送端共用当前端点和模型的已确认规则。
 * 关闭 = 直接回答（最快、最省）；档位越高思考越深、越慢、费用越高。
 */
export function EffortPicker({
  provider,
  model,
  value,
  onChange,
  compact
}: {
  provider: Pick<ProviderInfo, 'kind' | 'baseUrl' | 'sendEffort'> | null
  model: string | null
  value: Effort
  onChange: (e: Effort) => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const policy = provider ? resolveModelPolicy(provider, model) : null
  const levels = policy?.efforts ?? []
  const shown = policy ? normalizeEffort(policy, value) : null
  if (compact) {
    return (
      <Menu>
        <MenuTrigger asChild>
          <Button
            data-slot="input-group-button"
            className="rounded-full"
            size="sm"
            variant="ghost"
            aria-label={t('ai.effort')}
            title={t('ai.effortHint')}
          >
            <Brain data-icon="inline-start" />
            <span>
              {t('ai.effortShort')} · {shown ? t(`ai.efforts.${shown}`) : t('ai.effortDefault')}
            </span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuLabel>{t('ai.effort')}</MenuLabel>
          {!levels.length && <MenuLabel>{t(`ai.effortStates.${policy?.effortStatus ?? 'unknown'}`)}</MenuLabel>}
          <DropdownMenu.RadioGroup
            value={shown ?? ''}
            onValueChange={(next) => {
              if (levels.includes(next as Effort)) onChange(next as Effort)
            }}
          >
            {levels.map((level) => (
              <DropdownMenu.RadioItem
                key={level}
                value={level}
                className="relative flex max-w-[280px] cursor-default items-start gap-2 rounded-lg py-2 pr-3 pl-8 text-left text-xs text-fg outline-none select-none data-[highlighted]:bg-surface-hover"
              >
                <DropdownMenu.ItemIndicator className="absolute top-2.5 left-2">
                  <Check aria-hidden="true" className="size-3.5" />
                </DropdownMenu.ItemIndicator>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">{t(`ai.efforts.${level}`)}</span>
                  <span className="text-2xs leading-relaxed text-muted">{t(`ai.effortTips.${level}`)}</span>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </MenuContent>
      </Menu>
    )
  }
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
      {!levels.length && (
        <Tip label={t(`ai.effortStates.${policy?.effortStatus ?? 'unknown'}`)} side="top">
          <span className="px-2 text-xs text-muted">{t('ai.effortDefault')}</span>
        </Tip>
      )}
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
