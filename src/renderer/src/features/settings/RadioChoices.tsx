import { useId, type ReactNode } from 'react'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'

/** Card/pill presentation over the shared radio primitive, with finite values. */
export function RadioChoices<T extends string | number | null>({
  value,
  options,
  onChange,
  label,
  className,
  itemClassName,
  disabled
}: {
  value: T
  options: { value: T; label: ReactNode; disabled?: boolean; hint?: string }[]
  onChange: (value: T) => void
  label: string
  className?: string
  itemClassName?: (active: boolean) => string
  disabled?: boolean
}) {
  const id = useId()
  const key = (value: T): string => (value === null ? '__none' : String(value))
  return (
    <RadioGroup
      value={key(value)}
      disabled={disabled}
      aria-label={label}
      className={className}
      onValueChange={(next) => {
        const option = options.find((option) => key(option.value) === next && !option.disabled)
        if (option) onChange(option.value)
      }}
    >
      {options.map((option) => (
        <RadioGroupItem
          key={key(option.value)}
          variant="choice"
          id={`${id}-${key(option.value)}`}
          value={key(option.value)}
          aria-labelledby={`${id}-${key(option.value)}-label`}
          disabled={option.disabled}
          title={option.hint}
          className={cn(itemClassName?.(option.value === value), (disabled || option.disabled) && 'cursor-not-allowed opacity-50')}
        >
          <span id={`${id}-${key(option.value)}-label`}>{option.label}</span>
        </RadioGroupItem>
      ))}
    </RadioGroup>
  )
}
