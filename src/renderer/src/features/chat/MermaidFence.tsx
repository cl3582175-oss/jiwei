import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CustomRendererProps } from 'streamdown'
import { DiagramBox } from '../visuals/DiagramBox'
import { ExpandToggle } from '@/components/ui/ExpandableSurface'
import { ReplyExpandableSurface } from './ReplyExpandableSurface'

/** Ordinary Markdown diagrams share the same renderer and SVG sanitization as rich diagrams. */
export function MermaidFence({ code, isIncomplete }: CustomRendererProps) {
  const { t } = useTranslation()
  const [ready, setReady] = useState(false)
  const data = useMemo(() => ({ code }), [code])
  if (isIncomplete)
    return (
      <div role="status" className="rounded-lg bg-sunken px-4 py-3 text-xs text-subtle">
        {t('ui.generating')}
      </div>
    )
  return (
    <ReplyExpandableSurface title={t('ui.expand.untitled')} available={ready}>
      <div className="mermaid-surface my-3 overflow-hidden rounded-xl border border-border bg-surface">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm">
          <span>{t('ui.expand.untitled')}</span>
          <ExpandToggle />
        </header>
        <div className="ui-frame-body">
          <DiagramBox data={data} onReadyChange={setReady} />
        </div>
      </div>
    </ReplyExpandableSurface>
  )
}
