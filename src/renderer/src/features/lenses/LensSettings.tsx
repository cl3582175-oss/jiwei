import { PluginSourceLabel } from '../plugins/PluginSourceLabel'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { LensInfo } from '@shared/lens'
import { api } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, Input } from '@/components/ui/primitives'

export function lensTitle(lens: LensInfo, t: (key: string) => string): string {
  return lens.source === 'builtin' ? t(`lens.names.${lens.id.replace('lens-', '')}`) : lens.title
}
export function LensSettings() {
  const { t } = useTranslation(),
    { data: lenses = [], refetch } = useQuery({ queryKey: ['lenses'], queryFn: () => api.lenses.list() }),
    [editing, setEditing] = useState<LensInfo | null>(null),
    [clone, setClone] = useState(false),
    [title, setTitle] = useState(''),
    [instruction, setInstruction] = useState('')
  const edit = (lens: LensInfo, copy = false): void => {
    setEditing(lens)
    setClone(copy)
    setTitle(lens.title)
    setInstruction(lens.instruction)
  }
  const save = async (): Promise<void> => {
    await api.lenses.save({ title, instruction, ...(clone ? { copyFrom: editing!.id } : {}) }, clone ? undefined : editing!.id)
    setEditing(null)
    await refetch()
  }
  return (
    <section data-testid="lens-settings">
      <h2 className="font-serif text-lg">{t('lens.title')}</h2>
      <p className="my-3 text-xs text-muted">{t('lens.settingsDesc')}</p>
      <div className="space-y-2">
        {lenses.map((lens) => (
          <article key={lens.id} className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="mr-auto text-sm">{lensTitle(lens, t)}</strong>
              <PluginSourceLabel pluginId={lens.pluginId} />
              {lens.source !== 'user' ? (
                <Button variant="ghost" size="sm" onClick={() => edit(lens, true)}>
                  {t('lens.clone')}
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => edit(lens)}>
                    {t('lens.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void api.lenses
                        .remove(lens.id)
                        .then(() => refetch())
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    {t('lens.remove')}
                  </Button>
                </>
              )}
            </div>
            <details className="mt-2 text-xs text-muted">
              <summary>{t('lens.instruction')}</summary>
              <p className="mt-2 whitespace-pre-wrap">{lens.instruction}</p>
            </details>
          </article>
        ))}
      </div>
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent title={t(clone ? 'lens.clone' : 'lens.edit')}>
          <div className="mt-4 space-y-3">
            <Input aria-label={t('lens.name')} maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea
              aria-label={t('lens.instruction')}
              maxLength={2000}
              rows={8}
              className="w-full rounded-lg border border-border bg-surface p-2 text-sm"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={!title.trim() || !instruction.trim()}
              onClick={() => void save().catch((e) => toast.error(String(e)))}
            >
              {t('common.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
