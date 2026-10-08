import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FolderOpen, Import, RefreshCw, ChevronRight, Zap } from 'lucide-react'
import type { SkillInfo } from '@shared/types'
import { useSkills } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

// 「技能」：查看、启用 / 停用、导入（Agent Skills 标准 SKILL.md），打开技能文件夹自行编辑。

const errText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function SkillCard({ s }: { s: SkillInfo }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { data: body } = useQuery({ queryKey: ['skill', s.name], queryFn: () => api.skills.read(s.name), enabled: open })
  return (
    <li className="rounded-xl border border-border bg-surface">
      <div className="flex items-start gap-3 px-4 py-3">
        <button onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left" aria-expanded={open}>
          <span className="flex flex-wrap items-center gap-2">
            <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
            <span className="text-sm font-medium text-fg">{s.title}</span>
            <span className="font-mono text-2xs text-subtle">{s.name}</span>
            <span
              className={cn('rounded px-1.5 py-px text-2xs', s.source === 'user' ? 'bg-accent-soft text-accent' : 'bg-sunken text-muted')}
            >
              {t(`skills.source.${s.source}`)}
            </span>
            {s.minModel === 'strong' && (
              <span className="inline-flex items-center gap-0.5 rounded bg-sunken px-1.5 py-px text-2xs text-muted">
                <Zap className="size-3" />
                {t('skills.strong')}
              </span>
            )}
          </span>
          <span className="mt-1 block pl-5.5 text-xs leading-relaxed text-muted">{s.description}</span>
        </button>
        <Switch
          checked={s.enabled}
          aria-label={s.title}
          onCheckedChange={(v) => void api.skills.setEnabled(s.name, v).then((list) => qc.setQueryData(['skills'], list))}
        />
      </div>
      {open && (
        <pre className="max-h-[320px] overflow-auto border-t border-border bg-sunken/60 px-5 py-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-muted">
          {body ?? '…'}
        </pre>
      )}
    </li>
  )
}

export function SkillsSettingsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: list = [] } = useSkills()
  const doImport = async (): Promise<void> => {
    try {
      const s = await api.skills.import()
      if (s) {
        toast.success(t('skills.imported', { name: s.title }))
        void qc.invalidateQueries({ queryKey: ['skills'] })
      }
    } catch (e) {
      toast.error(errText(e))
    }
  }
  return (
    <div className="py-4">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h3 className="font-serif text-md font-semibold text-fg">{t('skills.title')}</h3>
          <p className="mt-1 max-w-[440px] text-xs leading-relaxed text-muted">{t('skills.desc')}</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void doImport()}>
            <Import />
            {t('skills.import')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void api.skills.openDir()} aria-label={t('skills.openDir')}>
            <FolderOpen />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('skills.reload')}
            onClick={() => void api.skills.reload().then((l) => qc.setQueryData(['skills'], l))}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <ul className="mt-5 space-y-2">
        {list.map((s) => (
          <SkillCard key={s.name} s={s} />
        ))}
      </ul>
      <p className="mt-4 text-2xs leading-relaxed text-subtle">{t('skills.footer')}</p>
    </div>
  )
}
