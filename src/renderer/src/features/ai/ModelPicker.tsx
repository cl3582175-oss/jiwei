import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Cpu } from 'lucide-react'
import { useProviders } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/primitives'

export interface ModelChoice {
  providerId: string | null
  model: string | null
}

/** 模型选择：按服务商分组列出已配置的模型 */
export function ModelPicker({ value, onChange, compact }: { value: ModelChoice; onChange: (v: ModelChoice) => void; compact?: boolean }) {
  const { t } = useTranslation()
  const { data: providers = [] } = useProviders()
  const current = providers.find((p) => p.id === value.providerId)
  const usable = providers.filter((p) => p.enabled && p.models.length)
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          className={cn(
            'inline-flex max-w-[260px] items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-surface-hover',
            compact ? 'h-7' : 'h-8'
          )}
          aria-label={t('ai.model')}
        >
          <Cpu className="size-3.5 shrink-0 text-subtle" />
          <span className="truncate">{value.model ? `${current?.name ?? ''} · ${value.model}` : t('ai.pickModel')}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[60vh] min-w-[240px] overflow-y-auto">
        {usable.length === 0 && <div className="px-3 py-3 text-xs text-subtle">{t('ai.noModels')}</div>}
        {usable.map((p, i) => (
          <div key={p.id}>
            {i > 0 && <MenuSeparator />}
            <MenuLabel>{p.name}</MenuLabel>
            {p.models.map((m) => (
              <MenuItem key={m} onSelect={() => onChange({ providerId: p.id, model: m })}>
                <Check className={cn(!(value.providerId === p.id && value.model === m) && 'invisible')} />
                <span className="font-mono text-xs">{m}</span>
              </MenuItem>
            ))}
          </div>
        ))}
      </MenuContent>
    </Menu>
  )
}
