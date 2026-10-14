import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react'
import type { ThemedToken } from 'shiki'
import type { StepsData } from '@shared/embeds/visuals'
import { cn } from '@/lib/utils'
import { useTokens } from './tokens'
function useHighlighted(d: StepsData, dark: boolean): ThemedToken[][] | null {
  const [lines, setLines] = useState<ThemedToken[][] | null>(null)
  useEffect(() => {
    if (!d) return
    let alive = true
    void (async () => {
      try {
        const { codeToTokens } = await import('shiki')
        const r = await codeToTokens(d.code, { lang: d.language as never, theme: dark ? 'github-dark' : 'github-light' })
        if (alive) setLines(r.tokens)
      } catch {
        // 不认识的语言：不高亮
        if (alive) setLines(d.code.split('\n').map((content) => [{ content, offset: 0 }]))
      }
    })()
    return () => {
      alive = false
    }
  }, [d, dark])
  return lines
}

export function CodeStepsBox({ data: d }: { data: StepsData }) {
  const { t } = useTranslation()
  const c = useTokens()
  const lines = useHighlighted(d, !!c.dark)
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing || !d) return
    const id = window.setInterval(() => setI((x) => (x + 1 < d.steps.length ? x + 1 : (setPlaying(false), x))), 2400)
    return () => window.clearInterval(id)
  }, [playing, d])
  const step = d.steps[Math.min(i, d.steps.length - 1)]
  const hl = new Set(step.lines)
  return (
    <div className="steps-view">
      {d.title && <p className="px-4 pt-3 font-serif text-sm font-semibold text-fg">{d.title}</p>}
      <pre className="steps-code">
        {(lines ?? d.code.split('\n').map((content) => [{ content, offset: 0, color: undefined }])).map((l, n) => (
          <div key={n} className={cn('steps-line', hl.has(n + 1) && 'is-on')}>
            <span className="steps-ln">{n + 1}</span>
            <span>
              {l.map((token, k) => (
                <span key={k} style={{ color: token.color }}>
                  {token.content}
                </span>
              ))}
            </span>
          </div>
        ))}
      </pre>
      <div className="flex items-start gap-3 border-t border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-2xs text-subtle">{t('embeds.stepOf', { n: i + 1, total: d.steps.length })}</p>
          <p className="mt-1 text-sm leading-relaxed text-fg">{step.note}</p>
          {step.vars && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(step.vars).map(([k, v]) => (
                <code key={k} className="rounded bg-sunken px-1.5 py-0.5 font-mono text-2xs text-muted">
                  {k} = {v}
                </code>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1" contentEditable={false}>
          <button className="embed-action" aria-label={t('embeds.prevStep')} disabled={i === 0} onClick={() => setI(i - 1)}>
            <ChevronLeft className="size-4" />
          </button>
          <button
            className="embed-action"
            aria-label={playing ? t('embeds.pause') : t('embeds.play')}
            onClick={() => (i >= d.steps.length - 1 ? (setI(0), setPlaying(true)) : setPlaying(!playing))}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <button className="embed-action" aria-label={t('embeds.nextStep')} disabled={i >= d.steps.length - 1} onClick={() => setI(i + 1)}>
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
