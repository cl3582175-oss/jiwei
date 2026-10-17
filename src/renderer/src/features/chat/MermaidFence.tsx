import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CustomRendererProps } from 'streamdown'
import { DiagramBox } from '../visuals/DiagramBox'

/** Ordinary Markdown diagrams share the same renderer and SVG sanitization as rich diagrams. */
export function MermaidFence({ code, isIncomplete }: CustomRendererProps) {
  const { t } = useTranslation()
  const data = useMemo(() => ({ code }), [code])
  if (isIncomplete)
    return (
      <div role="status" className="rounded-lg bg-sunken px-4 py-3 text-xs text-subtle">
        {t('ui.generating')}
      </div>
    )
  return <DiagramBox data={data} />
}
