import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { PopoverParts as Popover } from '@/components/ui/popover'
import { HelpCircle } from 'lucide-react'
import { api } from '@/lib/utils'
import { invalidate } from '@/lib/queries'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/shadcn-button'

/** 线索栏旁的“?”：一句话讲清康奈尔笔记法，可打开示例笔记 */
export function CornellHelp() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const openSample = async (): Promise<void> => {
    const note = await api.notes.createSample(i18n.language === 'en' ? 'en' : 'zh-CN')
    invalidate(qc, 'notes')
    useApp.getState().openNote(note.id)
  }
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="auto"
          className="ml-1.5 inline-grid size-4 place-items-center rounded-full text-subtle normal-case hover:text-accent"
          aria-label={t('cornellHelp.title')}
        >
          <HelpCircle className="size-3.5" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          className="glass z-50 w-72 rounded-xl border border-border/70 p-4 shadow-[var(--shadow-3)] data-[state=open]:animate-[pop-in_140ms_ease-out]"
        >
          <p className="font-display text-sm font-semibold text-fg">{t('cornellHelp.title')}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">{t('cornellHelp.body')}</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => void openSample()}>
            {t('cornellHelp.sample')}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
