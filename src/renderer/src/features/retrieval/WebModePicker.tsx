import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Globe, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { RETRIEVAL_DEFAULTS, type WebMode } from '@shared/retrieval'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/primitives'
import { useConversations, useSettings } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useRetrievalStatus } from './queries'

export function WebModePicker({ value, onChange }: { value: WebMode; onChange: (mode: WebMode) => void }) {
  const { t } = useTranslation()
  const { data: status } = useRetrievalStatus()
  const state = value === 'off' ? 'off' : status?.webAvailable ? value : status?.academicEnabled ? 'academic' : 'none'
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs text-fg hover:bg-surface-hover"
          aria-label={t('retrieval.picker.label')}
          data-testid="web-mode-picker"
        >
          <Globe className={cn('size-3.5', status?.webAvailable && value !== 'off' ? 'text-accent' : 'text-subtle')} />
          {t(`retrieval.picker.${state}`)}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        {(['auto', 'always', 'off'] as const).map((mode) => (
          <MenuItem key={mode} onSelect={() => onChange(mode)} title={t(`retrieval.modeHelp.${mode}`)} data-testid={`web-mode-${mode}`}>
            <Check className={cn(value !== mode && 'invisible')} />
            {t(`retrieval.mode.${mode}`)}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => useApp.getState().openSettings('search')} data-testid="web-mode-settings">
          <Settings2 />
          {t('retrieval.picker.settings')}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

export function useWebMode(
  conversationId: string | null,
  convWeb: WebMode | null | undefined
): { web: WebMode; setWeb: (mode: WebMode) => void } {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: settings } = useSettings()
  const { data: conversations } = useConversations()
  const conversation = conversations?.find((item) => item.id === conversationId)
  const [local, setLocal] = useState<{ id: string | null; web: WebMode | null }>({ id: conversationId, web: null })
  const currentId = useRef(conversationId)
  const generation = useRef(0)
  const lastRequest = useRef(0)
  if (currentId.current !== conversationId) {
    currentId.current = conversationId
    generation.current++
  }
  const defaultMode = settings?.retrieval.mode
  // null 是已确认的“跟随默认”，只有 undefined 才能使用补取的会话，避免旧缓存反向覆盖。
  const storedMode = convWeb === undefined ? conversation?.web : convWeb
  useEffect(() => {
    setLocal((previous) => {
      if (previous.id !== conversationId) return { id: conversationId, web: conversationId ? null : (defaultMode ?? null) }
      // 默认只在新会话开始时取一次；设置晚到也不能覆盖用户已选好的模式。
      if (!conversationId && previous.web === null && defaultMode) return { id: null, web: defaultMode }
      if (conversationId && previous.web !== null && storedMode === previous.web) return { id: conversationId, web: null }
      return previous
    })
  }, [conversationId, defaultMode, storedMode])
  const fallback = storedMode ?? defaultMode ?? RETRIEVAL_DEFAULTS.mode
  const web = local.id === conversationId ? (local.web ?? fallback) : fallback
  const setWeb = (mode: WebMode): void => {
    if (!conversationId) {
      setLocal({ id: null, web: mode })
      return
    }
    const id = conversationId,
      turn = generation.current,
      request = ++lastRequest.current
    // 现有对话先落库再显示；失败保留旧模式，旧回包也不能改掉之后新开的对话。
    void api.chat.update(id, { web: mode }).then(
      () => {
        if (currentId.current === id && generation.current === turn && lastRequest.current === request) setLocal({ id, web: mode })
        void qc.invalidateQueries({ queryKey: ['conversations'] })
      },
      () => toast.error(t('retrieval.picker.saveFailed'))
    )
  }
  return { web, setWeb }
}
