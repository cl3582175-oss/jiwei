import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import katex from 'katex'
import { CircleAlert, Loader2 } from 'lucide-react'
import { AnimationEmbedSchema, animationText, checkAnimation, type AnimationEmbed } from '@shared/manim'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useManimStatus, MANIM_ID } from '@/features/plugins/ManimRuntime'
import { registerEmbedView, type EmbedViewProps } from './registry'

// 笔记里的数学动画（v0.10）：块里只存参数；第一次显示时用 Manim 生成视频并按参数缓存。
// 没装运行环境时显示静态内容（推导的各步公式等），并告诉用户去哪里下载。

function useAnimation(entry: EmbedViewProps['entry']): AnimationEmbed | null {
  const json = JSON.stringify((entry.get('data') as { toJSON(): unknown } | undefined)?.toJSON?.() ?? null)
  return useMemo(() => {
    const r = AnimationEmbedSchema.safeParse(JSON.parse(json))
    return r.success && !checkAnimation(r.data.animation) ? r.data : null
  }, [json])
}

function StaticFallback({ d }: { d: AnimationEmbed }) {
  const a = d.animation
  if (a.kind === 'derivation')
    return (
      <ol className="space-y-2 px-4 py-2">
        {a.steps.map((s, i) => (
          <li key={i} className="flex items-baseline gap-3">
            <span className="text-2xs text-subtle tabular-nums">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: katex.renderToString(s.tex, { throwOnError: false }) }} />
            {s.note && <span className="text-xs text-muted">{s.note}</span>}
          </li>
        ))}
      </ol>
    )
  return <p className="px-4 py-2 text-sm whitespace-pre-wrap text-muted">{animationText({ animation: a })}</p>
}

function AnimationView({ entry }: EmbedViewProps) {
  const { t } = useTranslation()
  const d = useAnimation(entry)
  const { data: status } = useManimStatus()
  const ready = status?.state === 'ready'
  const clip = useQuery({
    queryKey: ['manim', 'clip', JSON.stringify(d?.animation)],
    queryFn: () => api.manim.clip(d!.animation),
    enabled: !!d && ready,
    staleTime: Infinity,
    retry: false
  })
  if (!d)
    return (
      <div className="flex items-start gap-2 px-4 py-3 text-xs text-danger">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        {t('embeds.missing')}
      </div>
    )
  return (
    <div data-testid="animation-embed">
      {d.title && <p className="px-4 pt-3 text-sm font-medium text-fg">{d.title}</p>}
      {ready && clip.data ? (
        <video src={clip.data} controls loop muted autoPlay playsInline className="mx-auto block aspect-[1088/432] w-full max-w-[720px]" />
      ) : ready && clip.isPending ? (
        <div className="flex aspect-[1088/432] w-full max-w-[720px] items-center justify-center gap-2 text-xs text-muted">
          <Loader2 className="size-4 animate-spin" />
          {t('embeds.animationRendering')}
        </div>
      ) : (
        <>
          <StaticFallback d={d} />
          <p className="px-4 pb-3 text-2xs text-subtle">
            {clip.error ? (
              <span className="text-danger">{(clip.error as Error).message}</span>
            ) : (
              <button
                className="underline-offset-2 hover:text-fg hover:underline"
                onClick={() => useApp.setState({ settingsOpen: true, settingsTab: 'plugins', settingsPluginId: MANIM_ID })}
              >
                {t('embeds.animationInstall')}
              </button>
            )}
          </p>
        </>
      )}
    </div>
  )
}

registerEmbedView({ kind: 'animation', label: 'embeds.animation', View: AnimationView })
