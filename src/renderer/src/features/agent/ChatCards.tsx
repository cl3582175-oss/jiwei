import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowUpRight, Ban, Check, Clock, PauseCircle, ShieldAlert, ShieldQuestion, TriangleAlert } from 'lucide-react'
import type { AgentStep } from '@shared/types'
import { Button } from '@/components/ui/button'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Confirmation, ConfirmationTitle, ConfirmationActions } from '@/components/ai-elements/confirmation'

// 积微助手（v0.7）：对话中的确认卡片、费用上限提示、办事结果的“查看”入口。

/** 办事工具创建的对象 → 打开对应页面 */
export function openStepLink(link: NonNullable<AgentStep['link']>): void {
  const s = useApp.getState()
  if (link.type === 'note') s.openNote(link.id)
  else if (link.type === 'source') s.openSource(link.id)
  else if (link.type === 'goal') s.openGoal(link.id)
  else if (link.type === 'task') {
    useApp.setState({ taskFocusId: link.id })
    s.openSettings('tasks')
  } else if (link.type === 'inbox') s.goNav('inbox')
  else s.goNav('today')
}

export function StepLinkButton({ link }: { link: NonNullable<AgentStep['link']> }) {
  const { t } = useTranslation()
  if (link.type === 'source') return null
  return (
    <button onClick={() => openStepLink(link)} className="inline-flex shrink-0 items-center gap-0.5 text-xs text-accent hover:underline">
      {t(`agent.link.${link.type}`)}
      <ArrowUpRight className="size-3" />
    </button>
  )
}

/** 需要用户确认的一步：等待时是醒目的卡片，处理后收成一行 */
export function ApprovalCard({ step }: { step: AgentStep }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const a = step.approval!
  const decide = async (allow: boolean): Promise<void> => {
    setBusy(true)
    try {
      await api.agent.decide({ id: a.id, allow })
    } finally {
      setBusy(false)
    }
  }
  if (a.state !== 'pending') {
    const ok = a.state === 'allowed'
    return (
      <div className="flex items-start gap-2 rounded-lg px-1 py-1 text-sm" data-testid="approval-resolved" data-state={a.state}>
        {ok ? (
          <Check className="mt-0.5 size-4 shrink-0 text-accent" />
        ) : a.state === 'expired' ? (
          <Clock className="mt-0.5 size-4 shrink-0 text-subtle" />
        ) : (
          <Ban className="mt-0.5 size-4 shrink-0 text-subtle" />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn('text-fg', !ok && 'text-muted line-through decoration-subtle/60')}>{a.title}</span>
          <span className="ml-2 text-xs text-subtle">{t(`agent.approval.${a.state}`)}</span>
        </span>
        {ok && step.status === 'done' && step.link && <StepLinkButton link={step.link} />}
      </div>
    )
  }
  return (
    <Confirmation role="group" aria-label={t('agent.approval.title')} data-testid="approval-card">
      <ConfirmationTitle>
        {a.level === 'external' ? <ShieldAlert className="size-4" /> : <ShieldQuestion className="size-4" />}
        {t('agent.approval.title')}
        <span className="rounded-full bg-surface px-2 py-px text-xs font-normal text-muted">{t(`agent.approval.${a.level}`)}</span>
        {step.server && <span className="truncate text-xs font-normal text-muted">· {step.server}</span>}
      </ConfirmationTitle>
      <p className="mt-2 text-sm leading-relaxed text-fg">{a.title}</p>
      {a.detail && (
        <p className="mt-1 max-h-32 overflow-y-auto text-xs leading-relaxed break-words whitespace-pre-wrap text-muted">{a.detail}</p>
      )}
      {a.tainted && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs leading-relaxed text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {t('agent.approval.tainted')}
        </p>
      )}
      <ConfirmationActions>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide(true)}>
          {t('agent.approval.allow')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>
          {t('agent.approval.deny')}
        </Button>
      </ConfirmationActions>
    </Confirmation>
  )
}

const BUDGET = /^\[budget:(daily|monthly|run)\]\s*/

export const budgetKind = (error: string | null): 'daily' | 'monthly' | 'run' | null =>
  (BUDGET.exec(error ?? '')?.[1] as 'daily' | 'monthly' | 'run' | undefined) ?? null

/** 费用上限：说明已暂停，可以今天继续或调整上限 */
export function BudgetNotice({ error }: { error: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const kind = budgetKind(error)!
  const [done, setDone] = useState(false)
  const amount = /\$[\d.]+/.exec(error)?.[0]
  const allow = async (): Promise<void> => {
    await api.usage.allowToday()
    void qc.invalidateQueries({ queryKey: ['usage'] })
    setDone(true)
    toast.success(t('agent.budget.continued'))
  }
  return (
    <div className="mt-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3" data-testid="budget-notice">
      <p className="flex items-center gap-2 text-sm font-medium text-fg">
        <PauseCircle className="size-4 text-warning" />
        {t(`agent.budget.${kind}`)}
        {amount && <span className="font-normal text-muted">{amount}</span>}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{t('agent.budget.hint')}</p>
      <div className="mt-2.5 flex items-center gap-2">
        {kind !== 'run' && (
          <Button size="sm" variant="primary" disabled={done} onClick={() => void allow()}>
            {t('agent.budget.continueToday')}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => useApp.getState().openSettings('usage')}>
          {t('agent.budget.adjust')}
        </Button>
      </div>
    </div>
  )
}
