import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Check, ChevronDown, Cpu } from 'lucide-react'
import { useProviders } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { InputGroupButton } from '@/components/ai-elements/input-group'
import {
  ModelSelector,
  ModelSelectorTrigger,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorList,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorEmpty
} from '@/components/ai-elements/model-selector'

export interface ModelChoice {
  providerId: string | null
  model: string | null
}

/** 模型选择：按服务商分组列出已配置的模型 */
export function ModelPicker({ value, onChange, compact }: { value: ModelChoice; onChange: (v: ModelChoice) => void; compact?: boolean }) {
  const { t } = useTranslation()
  const { data: providers = [] } = useProviders()
  const [open, setOpen] = useState(false)
  const current = providers.find((p) => p.id === value.providerId)
  const usable = providers.filter((p) => p.enabled && p.models.length)
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <InputGroupButton
          size="sm"
          variant={compact ? 'ghost' : 'outline'}
          className={cn('min-w-0 max-w-[220px] gap-1.5', !compact && 'h-8')}
          aria-label={t('ai.model')}
          title={value.model ? `${current?.name ?? ''} · ${value.model}` : t('ai.pickModel')}
        >
          <Cpu data-icon="inline-start" />
          <span className="truncate">
            {value.model ? (compact ? value.model : `${current?.name ?? ''} · ${value.model}`) : t('ai.pickModel')}
          </span>
          <ChevronDown data-icon="inline-end" />
        </InputGroupButton>
      </ModelSelectorTrigger>
      <ModelSelectorContent title={t('ai.pickModel')}>
        <ModelSelectorInput aria-label={t('ai.searchModels')} placeholder={t('ai.searchModels')} />
        <ModelSelectorList>
          <ModelSelectorEmpty className="px-3 py-6 text-xs text-muted">
            {t(usable.length ? 'ai.noMatchingModels' : 'ai.noModels')}
          </ModelSelectorEmpty>
          {usable.map((p) => (
            <ModelSelectorGroup key={p.id} heading={p.name}>
              {p.models.map((m) => (
                <ModelSelectorItem
                  key={m}
                  value={`${p.id}/${m}`}
                  keywords={[p.name, m]}
                  aria-label={m}
                  onSelect={() => {
                    onChange({ providerId: p.id, model: m })
                    setOpen(false)
                  }}
                >
                  <Check className={cn(!(value.providerId === p.id && value.model === m) && 'invisible')} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={m}>
                    {m}
                  </span>
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
