import type { ReactNode } from 'react'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'

/** Controlled single choice: selecting the active option never clears it. */
export function Segmented<T extends string>({ value, options, onChange, label, ...props }: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  label?: string
  id?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  disabled?: boolean
}) {
  return (
    <ToggleGroup type="single" value={value} variant="segmented" size="sm" spacing={1}
      aria-label={label} className="no-drag inline-flex max-w-full flex-wrap rounded-lg bg-sunken p-0.5"
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next)
        if (option) onChange(option.value)
      }} {...props}>
      {options.map((option) => <ToggleGroupItem key={option.value} value={option.value}>{option.label}</ToggleGroupItem>)}
    </ToggleGroup>
  )
}
