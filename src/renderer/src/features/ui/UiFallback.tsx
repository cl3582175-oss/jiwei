import { useTranslation } from 'react-i18next'
import { Streamdown } from 'streamdown'
import { uiFallbackMarkdown } from '@shared/ui/catalog'

export function UiFallback({ raw, value, unknown }: { raw: string; value?: unknown; unknown?: boolean }) {
  const { t } = useTranslation()
  if (unknown)
    return (
      <details className="px-4 py-3 text-sm">
        <summary className="cursor-pointer text-muted">{t('ui.failed')}</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">{raw}</pre>
      </details>
    )
  return (
    <div className="px-4 py-3">
      <p className="mb-2 text-2xs text-subtle">{t('ui.fellBack')}</p>
      <Streamdown mode="static">{uiFallbackMarkdown(value, raw)}</Streamdown>
    </div>
  )
}
