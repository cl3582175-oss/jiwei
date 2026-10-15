import { useEffect, useRef, useState } from 'react'
import { createAutosave } from '@/lib/autosave'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Pin,
  PinOff,
  Pencil,
  Trash2,
  Plus,
  Sparkles,
  UserRound,
  ShieldAlert,
  Check,
  X,
  RotateCcw,
  MessageSquare,
  Quote,
  GraduationCap,
  ChevronRight,
  Folder
} from 'lucide-react'
import { PROFILE_KEYS, type Concept, type Memory, type MemoryKind, type MemorySettings, type ProfileKey } from '@shared/types'
import type { ChatProject } from '@shared/chatProjects'
import { useChatProjects, useMemories, useUserProfile } from '@/lib/queries'
import { api, cn, formatDate, formatRelative } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/primitives'
import { confirm, prompt } from '@/components/ui/confirm'
import { LearningProfile } from './LearningProfile'

// 「关于我」：积微对你的了解，全部可查看、可修改、可删除。
//   档案（你预设的）· 记忆（偏好、事实、术语、技能偏好；已淡出的可恢复）· 学习情况（概念掌握度）· 学习经历

type Section = 'profile' | 'memories' | 'concepts' | 'episodes'
const SECTIONS: Section[] = ['profile', 'memories', 'concepts', 'episodes']
const LIST_KINDS: MemoryKind[] = ['preference', 'fact', 'glossary', 'skill']

function ProfileField({ k, value }: { k: ProfileKey; value: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [draft, setDraft] = useState(value)
  const [status, setStatus] = useState<'saving' | 'saved'>('saved')
  const focused = useRef(false)
  const [save] = useState(() =>
    createAutosave(
      value,
      async (text: string) => {
        await api.memory.setProfile({ [k]: text.trim() })
        void qc.invalidateQueries({ queryKey: ['userProfile'] })
      },
      { onState: setStatus, onError: () => toast.error(t('memory.saveFailed')) }
    )
  )
  useEffect(() => {
    if (!focused.current && !save.dirty) {
      save.accept(value)
      setDraft(value)
    }
  }, [value, save])
  useEffect(() => {
    const flush = () => {
      void save.flush().catch(() => {})
    }
    window.addEventListener('jiwei:flush-settings', flush)
    return () => {
      window.removeEventListener('jiwei:flush-settings', flush)
      flush()
    }
  }, [save])
  return (
    <label className="block">
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg">{t(`memory.profile.${k}`)}</span>
        <span role="status" className="text-2xs text-subtle">
          {t(`memory.${status === 'saving' ? 'saving' : 'saved'}`)}
        </span>
      </span>
      <textarea
        value={draft}
        rows={k === 'role' ? 1 : 2}
        placeholder={t(`memory.profile.${k}Ph`)}
        aria-label={t(`memory.profile.${k}`)}
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          save.change(e.target.value)
        }}
        onBlur={() => {
          focused.current = false
          void save.flush().catch(() => {})
        }}
        className="mt-1.5 block w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-fg outline-none placeholder:text-subtle focus:border-accent"
      />
    </label>
  )
}

function MemoryRow({ m }: { m: Memory }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['memories'] })
  const edit = async (): Promise<void> => {
    const v = await prompt({ title: t('memory.edit'), defaultValue: m.content, confirmText: t('common.save') })
    if (v?.trim() && v.trim() !== m.content)
      await api.memory.save({ id: m.id, kind: m.kind, projectId: m.projectId ?? null, content: v.trim() })
    refresh()
  }
  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: t('memory.removeTitle'), description: m.content, confirmText: t('common.delete'), danger: true }))) return
    await api.memory.remove(m.id)
    refresh()
  }
  const archived = m.status === 'archived'
  return (
    <li
      className={cn(
        'group flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-hover',
        m.status === 'pending' && 'bg-accent-soft/40'
      )}
    >
      <span className="mt-0.5 shrink-0 text-subtle [&_svg]:size-3.5">
        {m.status === 'pending' ? <ShieldAlert className="text-[#b8862b]" /> : m.origin === 'ai' ? <Sparkles /> : <UserRound />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm leading-relaxed', archived ? 'text-muted' : 'text-fg')}>{m.content}</p>
        {m.evidence?.quote && (
          <p className="mt-0.5 line-clamp-1 text-2xs text-subtle" title={m.evidence.quote}>
            <Quote className="mr-1 inline size-2.5 -translate-y-px" />
            {m.evidence.quote}
          </p>
        )}
        <p className="mt-0.5 text-2xs text-subtle">
          {m.status === 'pending'
            ? t('memory.pending')
            : archived
              ? t('memory.faded')
              : m.origin === 'ai'
                ? t('memory.byAi')
                : t('memory.byYou')}
          {m.skill && ` · ${m.skill}`} · {formatRelative(m.updatedAt, i18n.language)}
          {m.useCount > 0 && ` · ${t('memory.used', { count: m.useCount })}`}
        </p>
      </div>
      {m.status === 'pending' ? (
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="primary" onClick={() => void api.memory.confirm(m.id).then(refresh)}>
            <Check />
            {t('memory.confirm')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void api.memory.remove(m.id).then(refresh)}>
            <X />
            {t('memory.dismiss')}
          </Button>
        </div>
      ) : archived ? (
        <div className="flex shrink-0 gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void api.memory
                .save({ id: m.id, kind: m.kind, projectId: m.projectId ?? null, content: m.content, status: 'active' })
                .then(refresh)
            }
          >
            <RotateCcw />
            {t('memory.restore')}
          </Button>
          <Tip label={t('common.delete')}>
            <Button size="icon-sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove()}>
              <Trash2 />
            </Button>
          </Tip>
        </div>
      ) : (
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Tip label={m.pinned ? t('memory.unpin') : t('memory.pin')}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.pinned ? t('memory.unpin') : t('memory.pin')}
              onClick={() =>
                void api.memory
                  .save({ id: m.id, kind: m.kind, projectId: m.projectId ?? null, content: m.content, pinned: !m.pinned })
                  .then(refresh)
              }
            >
              {m.pinned ? <PinOff /> : <Pin />}
            </Button>
          </Tip>
          <Tip label={t('memory.edit')}>
            <Button size="icon-sm" variant="ghost" aria-label={t('memory.edit')} onClick={() => void edit()}>
              <Pencil />
            </Button>
          </Tip>
          <Tip label={t('common.delete')}>
            <Button size="icon-sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove()}>
              <Trash2 />
            </Button>
          </Tip>
        </div>
      )}
      {m.pinned && m.status === 'active' && <Pin className="mt-1 size-3 shrink-0 text-accent group-hover:hidden" />}
    </li>
  )
}

function LearnSwitches() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['memorySettings'], queryFn: () => api.memory.settings() })
  if (!data) return null
  const set = (patch: Partial<MemorySettings>): void =>
    void api.memory.setSettings(patch).then((s) => qc.setQueryData(['memorySettings'], s))
  const row = (k: keyof MemorySettings) => (
    <label key={k} className="flex items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm text-fg">{t(`memory.learn.${k}`)}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{t(`memory.learn.${k}Desc`)}</span>
      </span>
      <Switch checked={data[k]} onCheckedChange={(v) => set({ [k]: v })} aria-label={t(`memory.learn.${k}`)} className="mt-0.5" />
    </label>
  )
  return <div className="rounded-xl border border-border px-4 py-1.5">{(['autoLearn', 'learnSkills'] as const).map(row)}</div>
}

function ProjectMemoryGroup({
  project,
  kind,
  episodes = false
}: {
  project: ChatProject
  kind: MemoryKind | 'all' | 'archived'
  episodes?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { data: list = [], isPending, isError } = useMemories(project.id)
  const { data: archived = [] } = useQuery({
    queryKey: ['memories', 'project', project.id, 'archived'],
    queryFn: () => api.memory.list({ projectId: project.id, status: 'archived' }),
    enabled: kind === 'archived'
  })
  const shown = (kind === 'archived' ? archived : list).filter((m) =>
    episodes ? m.kind === 'episode' : LIST_KINDS.includes(m.kind) && (kind === 'all' || kind === 'archived' || m.kind === kind)
  )
  const ordered = [...shown.filter((m) => m.status === 'pending'), ...shown.filter((m) => m.status !== 'pending')]
  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-border" data-project-memory={project.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-fg hover:bg-surface-hover"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        <Folder className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <span className="text-2xs font-normal text-subtle">{ordered.length}</span>
      </button>
      {open && (
        <div className="border-t border-border px-1 py-2">
          <p className="px-3 py-1 text-2xs text-subtle">{t('projects.memoryProjectDesc')}</p>
          {ordered.length ? (
            <ul>
              {ordered.map((m) => (
                <MemoryRow key={m.id} m={m} />
              ))}
            </ul>
          ) : (
            <p className="px-3 py-5 text-xs text-muted">
              {t(isPending ? 'projects.loading' : isError ? 'projects.loadFailed' : 'projects.noMemories')}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function MemoriesSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: list = [] } = useMemories()
  const [kind, setKind] = useState<MemoryKind | 'all' | 'archived'>('all')
  const { data: projects = [] } = useChatProjects()
  const { data: archived = [] } = useQuery({
    queryKey: ['memories', 'archived'],
    queryFn: () => api.memory.list({ status: 'archived' }),
    enabled: kind === 'archived'
  })
  const shown =
    kind === 'archived'
      ? archived.filter((m) => m.kind !== 'episode' && m.kind !== 'profile')
      : list.filter((m) => LIST_KINDS.includes(m.kind) && (kind === 'all' || m.kind === kind))
  const ordered = [...shown.filter((m) => m.status === 'pending'), ...shown.filter((m) => m.status !== 'pending')]

  const add = async (): Promise<void> => {
    const v = await prompt({ title: t('memory.addTitle'), placeholder: t('memory.addPh'), confirmText: t('common.save') })
    if (!v?.trim()) return
    await api.memory.save({ kind: kind === 'all' || kind === 'archived' ? 'preference' : kind, content: v.trim() })
    void qc.invalidateQueries({ queryKey: ['memories'] })
  }

  return (
    <section>
      <LearnSwitches />
      <div className="mt-6 flex items-center justify-between gap-4">
        <div>
          <h3 className="font-serif text-md font-semibold text-fg">{t('memory.listTitle')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t('memory.listDesc')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void add()}>
          <Plus />
          {t('memory.add')}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(['all', ...LIST_KINDS, 'archived'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs transition-colors',
              kind === k ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg'
            )}
          >
            {t(`memory.kinds.${k}`)}
          </button>
        ))}
      </div>
      {ordered.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs leading-relaxed text-muted">
          {kind === 'archived' ? t('memory.emptyArchived') : t('memory.empty')}
        </p>
      ) : (
        <ul className="mt-3 space-y-0.5">
          {ordered.map((m) => (
            <MemoryRow key={m.id} m={m} />
          ))}
        </ul>
      )}
      {projects
        .filter((project) => project.memory === 'project')
        .map((project) => (
          <ProjectMemoryGroup key={project.id} project={project} kind={kind} />
        ))}
    </section>
  )
}

const LEVEL_BAR: Record<Concept['level'], string> = { weak: 'bg-danger', learning: 'bg-[#b8862b]', solid: 'bg-accent' }

function ConceptRow({ c }: { c: Concept }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['concepts'] })
  const counts = [
    c.asked && t('memory.concept.asked', { count: c.asked }),
    c.confused && t('memory.concept.confused', { count: c.confused }),
    c.understood && t('memory.concept.understood', { count: c.understood })
  ].filter(Boolean)
  return (
    <li className="group rounded-lg px-3 py-2.5 hover:bg-surface-hover" data-concept={c.name}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{c.name}</span>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Tip label={t('feynman.action')}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`${t('feynman.action')}：${c.name}`}
              onClick={() => {
                useApp.getState().setSettingsOpen(false)
                useApp.getState().startFeynman({ concept: c.name })
              }}
            >
              <GraduationCap />
            </Button>
          </Tip>
          {(['weak', 'learning', 'solid'] as const).map((l) => (
            <button
              key={l}
              onClick={() => void api.memory.setConceptLevel(c.id, l).then(refresh)}
              className={cn(
                'rounded-md px-1.5 py-0.5 text-2xs transition-colors',
                c.level === l ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-sunken hover:text-fg'
              )}
            >
              {t(`memory.concept.${l}`)}
            </button>
          ))}
          <Tip label={t('common.delete')}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('common.delete')}
              onClick={() => void api.memory.removeConcept(c.id).then(refresh)}
            >
              <Trash2 />
            </Button>
          </Tip>
        </div>
        <span className="w-12 shrink-0 text-right text-2xs text-muted group-hover:hidden">{t(`memory.concept.${c.level}`)}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sunken">
        <div
          className={cn('h-full rounded-full transition-[width]', LEVEL_BAR[c.level])}
          style={{ width: `${Math.max(4, c.mastery * 100)}%` }}
        />
      </div>
      <p className="mt-1 text-2xs text-subtle">
        {[...counts, formatRelative(c.lastSeen, i18n.language)].join(' · ')}
        {c.note && c.level !== 'solid' && <span className="text-muted"> · {t('memory.concept.stuck', { note: c.note })}</span>}
      </p>
    </li>
  )
}

function ConceptsSection() {
  const { t } = useTranslation()
  const { data: list = [] } = useQuery({ queryKey: ['concepts'], queryFn: () => api.memory.concepts() })
  const [level, setLevel] = useState<Concept['level'] | 'all'>('all')
  const shown = list.filter((c) => level === 'all' || c.level === level)
  return (
    <section>
      <h3 className="font-serif text-md font-semibold text-fg">{t('memory.conceptsTitle')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">{t('memory.conceptsDesc')}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(['all', 'weak', 'learning', 'solid'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs transition-colors',
              level === l ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg'
            )}
          >
            {l === 'all' ? t('memory.kinds.all') : t(`memory.concept.${l}`)}
            <span className="ml-1 opacity-60">{l === 'all' ? list.length : list.filter((c) => c.level === l).length}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs leading-relaxed text-muted">
          {t('memory.conceptsEmpty')}
        </p>
      ) : (
        <ul className="mt-3 space-y-0.5">
          {shown.map((c) => (
            <ConceptRow key={c.id} c={c} />
          ))}
        </ul>
      )}
    </section>
  )
}

function EpisodesSection() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: list = [] } = useMemories()
  const episodes = list.filter((m) => m.kind === 'episode')
  const { data: projects = [] } = useChatProjects()
  // 费曼练习回到练习页面，其他对话回到对话页
  const open = async (id: string): Promise<void> => {
    const c = await api.feynman.get(id)
    useApp.getState().setSettingsOpen(false)
    if (c?.feynman) useApp.getState().startFeynman({ ...c.feynman, conversationId: c.id })
    else useApp.getState().openConversation(id)
  }
  return (
    <section>
      <h3 className="font-serif text-md font-semibold text-fg">{t('memory.episodesTitle')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">{t('memory.episodesDesc')}</p>
      {episodes.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs leading-relaxed text-muted">
          {t('memory.episodesEmpty')}
        </p>
      ) : (
        <ol className="relative mt-4 space-y-1 border-l border-border pl-4">
          {episodes.map((m) => (
            <li key={m.id} className="group relative rounded-lg px-3 py-2 hover:bg-surface-hover">
              <span className="absolute top-3.5 -left-[21px] size-2 rounded-full border-2 border-surface bg-accent" />
              <p className="text-2xs text-subtle">{formatDate(m.updatedAt, i18n.language)}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-fg">{m.content}</p>
              <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                {m.evidence?.conversationId && (
                  <Tip label={t('memory.openChat')}>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('memory.openChat')}
                      onClick={() => void open(m.evidence!.conversationId!)}
                    >
                      <MessageSquare />
                    </Button>
                  </Tip>
                )}
                <Tip label={t('common.delete')}>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('common.delete')}
                    onClick={() => void api.memory.remove(m.id).then(() => qc.invalidateQueries({ queryKey: ['memories'] }))}
                  >
                    <Trash2 />
                  </Button>
                </Tip>
              </div>
            </li>
          ))}
        </ol>
      )}
      {projects
        .filter((project) => project.memory === 'project')
        .map((project) => (
          <ProjectMemoryGroup key={project.id} project={project} kind="all" episodes />
        ))}
    </section>
  )
}

export function MemorySettingsTab() {
  const { t } = useTranslation()
  const { data: profile } = useUserProfile()
  const [section, setSection] = useState<Section>('profile')
  return (
    <div className="py-4">
      <div role="tablist" className="mb-6 inline-flex rounded-lg bg-sunken p-0.5">
        {SECTIONS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={section === s}
            onClick={() => setSection(s)}
            className={cn(
              'rounded-md px-3 py-1 text-xs transition-colors',
              section === s ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg'
            )}
          >
            {t(`memory.sections.${s}`)}
          </button>
        ))}
      </div>

      {section === 'profile' && (
        <section>
          <h3 className="font-serif text-md font-semibold text-fg">{t('memory.profileTitle')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t('memory.profileDesc')}</p>
          {profile && (
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4">
              {PROFILE_KEYS.map((k) => (
                <div key={k} className={cn(k === 'role' || k === 'avoid' ? 'col-span-2' : '')}>
                  <ProfileField k={k} value={profile[k] ?? ''} />
                </div>
              ))}
            </div>
          )}
          <LearningProfile />
        </section>
      )}
      {section === 'memories' && <MemoriesSection />}
      {section === 'concepts' && <ConceptsSection />}
      {section === 'episodes' && <EpisodesSection />}
    </div>
  )
}
