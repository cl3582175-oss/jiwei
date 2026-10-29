import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover } from 'radix-ui'
import { TextCursorInput } from 'lucide-react'
import { validContext, type ModelCaps } from '@shared/ai'
import { Button } from '@/components/ui/button'
import { Input, Tip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { ContextTag, ContextUsage } from '@/components/ai-elements/context'

const label = (value: number): string => (value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(2)}M` : `${+(value / 1000).toFixed(1)}K`)

/** 与其它能力共用 modelCaps；恢复自动只移除手动值，保留发现/学习信息。 */
export function ContextChip({ model, caps, onSave }: { model: string; caps: ModelCaps; onSave: (context: number | undefined) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false),
    [value, setValue] = useState('')
  const source = t(`ai.caps.contextSource.${caps.contextSource}`)
  const save = (context: number | undefined): void => {
    onSave(context)
    setOpen(false)
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setValue(String(caps.context))
      }}
    >
      <Tip label={t('ai.caps.contextHelp')}>
        <Popover.Trigger asChild>
          <ContextTag asChild>
            <button
              aria-label={`${model} ${t('ai.caps.context')}`}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full px-2 text-2xs text-muted hover:bg-sunken [&_svg]:size-3',
                caps.contextSource === 'manual' && 'ring-1 ring-accent/40'
              )}
            >
              <TextCursorInput />
              {t('ai.caps.context')} {label(caps.context)}（{source}）
            </button>
          </ContextTag>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content sideOffset={6} align="end" className="z-[60] w-72 rounded-xl border border-border bg-surface p-3 shadow-float">
          <p className="mb-2 text-xs text-muted">{t('ai.caps.contextHelp')}</p>
          <div className="flex flex-wrap gap-1">
            {[32000, 64000, 128000, 200000, 1000000].map((n) => (
              <Button key={n} variant="ghost" size="sm" onClick={() => save(n)}>
                {label(n)}
              </Button>
            ))}
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (validContext(Number(value))) save(Number(value))
            }}
          >
            <Input
              type="number"
              min={1024}
              max={100000000}
              step={1}
              aria-label={t('ai.caps.contextTokens')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={!validContext(Number(value))}>
              {t('common.save')}
            </Button>
          </form>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => save(undefined)}>
            {t('ai.caps.contextAuto')}
          </Button>
          <ContextUsage className="mt-1 block">
            {t('ai.caps.contextAutomatic', {
              value: label(caps.auto.context),
              source: t(`ai.caps.contextSource.${caps.auto.contextSource}`)
            })}
          </ContextUsage>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
