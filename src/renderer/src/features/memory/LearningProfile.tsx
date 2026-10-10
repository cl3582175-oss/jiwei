import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/utils'
import { VocabularySettings } from '../reading/ReadingSettings'

export function LearningProfile() {
  const { t } = useTranslation(),
    qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['mistakeStatistics'], queryFn: () => api.mistakes.statistics() })
  useEffect(
    () =>
      window.jiweiEvents.on('mistakes:changed', () => {
        void qc.invalidateQueries({ queryKey: ['mistakeStatistics'] })
      }),
    [qc]
  )
  return (
    <div className="mt-6 space-y-6" data-testid="learning-profile">
      <VocabularySettings />
      <section>
        <h3 className="font-serif text-md font-semibold">{t('learning.causeDistribution')}</h3>
        <p className="mt-1 text-xs text-muted">{t('learning.statisticsHint')}</p>
        {data && (
          <div className="mt-3 space-y-2">
            <p className="text-sm">{t('learning.summary', { count: data.total, verified: Math.round(data.verifiedRatio * 100) })}</p>
            {data.causes
              .filter((c) => c.count)
              .map((c) => (
                <div key={c.cause} className="flex items-center gap-3 text-xs">
                  <span className="w-20 shrink-0">{t(`learning.causes.${c.cause}`)}</span>
                  <div className="h-1 flex-1 overflow-hidden rounded bg-sunken">
                    <div className="h-full bg-accent" style={{ width: `${c.percentage}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right text-muted">
                    {Math.round(c.percentage)}% · {c.count}
                  </span>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  )
}
