import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RadioChoices } from '../../src/renderer/src/features/settings/RadioChoices'
import '../../src/renderer/src/styles/globals.css'

// Production component semantics only. No bridge, provider, or pretend IPC write.
function SettingsControls() {
  const [policy, setPolicy] = useState<'ask' | 'auto' | 'deny'>('ask')
  const [external, setExternal] = useState<'ask' | 'auto' | 'deny'>('ask')
  const options = [
    { value: 'ask' as const, label: '每次询问' },
    { value: 'auto' as const, label: '自动' },
    { value: 'deny' as const, label: '禁止' }
  ]
  return (
    <main className="space-y-8 bg-bg p-8 text-fg">
      <RadioChoices
        value={policy}
        onChange={setPolicy}
        label="工具策略"
        options={options}
        className="inline-flex w-fit gap-1"
        itemClassName={(active) => `inline-flex h-7 items-center rounded-md px-3 text-xs ${active ? 'bg-surface text-fg' : 'text-muted'}`}
      />
      <output data-testid="policy">{policy}</output>
      <RadioChoices
        value={external}
        onChange={setExternal}
        label="对外工具策略"
        options={options.map((option) => ({ ...option, disabled: option.value === 'auto' }))}
        className="inline-flex w-fit gap-1"
        itemClassName={() => 'inline-flex h-7 items-center rounded-md px-3 text-xs'}
      />
      <output data-testid="external-policy">{external}</output>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<SettingsControls />)
