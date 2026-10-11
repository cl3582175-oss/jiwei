import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Cable, Check, ChevronRight, Copy, KeyRound, LogOut, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import {
  allowedPolicies,
  type McpAccess,
  type McpClientInfo,
  type McpClientSecret,
  type McpServerInfo,
  type McpServerInput,
  type ToolPolicy
} from '@shared/agent'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { confirm } from '@/components/ui/confirm'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import { MailSettings } from '../tasks/MailSettings'

// 设置 → 连接（v0.7）：积微使用外部 MCP 工具；让其他应用通过 MCP 使用积微。

const errText = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)

function Choice<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { value: T; label: string; disabled?: boolean; hint?: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="inline-flex shrink-0 rounded-lg border border-border bg-sunken p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-md px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            value === o.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Field({ label, hint, children, group }: { label: string; hint?: string; children: ReactNode; group?: boolean }) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className="block">
      <span className="block text-sm text-fg">{label}</span>
      {hint && <span className="mt-0.5 block text-xs leading-relaxed text-subtle">{hint}</span>}
      <span className="mt-1.5 block">{children}</span>
    </Tag>
  )
}
const inputCls =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-subtle focus:border-accent'

const STATE_DOT: Record<McpServerInfo['state'], string> = {
  off: 'bg-border',
  idle: 'bg-subtle/60',
  connecting: 'bg-accent animate-pulse',
  ready: 'bg-accent',
  auth: 'bg-warning',
  error: 'bg-danger'
}

/* ——— 外部工具：添加 / 修改 ——— */

const parseLines = (s: string, sep: RegExp): Record<string, string> =>
  Object.fromEntries(
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = sep.exec(l)
        return m ? [l.slice(0, m.index).trim(), l.slice(m.index + m[0].length).trim()] : [l, '']
      })
      .filter(([k]) => k)
  )

function ServerForm({ initial, onDone }: { initial?: McpServerInfo; onDone: (saved?: McpServerInfo) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'http'>(initial?.transport ?? 'stdio')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [args, setArgs] = useState((initial?.args ?? []).join('\n'))
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headers, setHeaders] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    const input: McpServerInput = {
      ...(initial ? { id: initial.id } : {}),
      name: name.trim(),
      transport,
      ...(transport === 'stdio'
        ? {
            command: command.trim(),
            args: args
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean),
            ...(env.trim() ? { env: parseLines(env, /=/) } : {})
          }
        : { url: url.trim(), ...(headers.trim() ? { headers: parseLines(headers, /:\s*/) } : {}) })
    }
    setBusy(true)
    try {
      const saved = await api.mcp.saveServer(input)
      const tested = await api.mcp.testServer(saved.id)
      onDone(tested)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const valid = name.trim() && (transport === 'stdio' ? command.trim() : /^https?:\/\//i.test(url.trim()))
  return (
    <div className="space-y-4 rounded-xl border border-border bg-sunken/50 p-4" data-testid="mcp-server-form">
      <p className="text-sm font-medium text-fg">{initial ? t('agent.conn.form.editTitle') : t('agent.conn.form.title')}</p>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label={t('agent.conn.form.name')}>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('agent.conn.form.namePh')}
            aria-label={t('agent.conn.form.name')}
          />
        </Field>
        <Field label={t('agent.conn.form.transport')} group>
          <Choice
            label={t('agent.conn.form.transport')}
            value={transport}
            onChange={setTransport}
            options={[
              { value: 'stdio', label: t('agent.conn.form.stdio') },
              { value: 'http', label: t('agent.conn.form.http') }
            ]}
          />
        </Field>
      </div>
      {transport === 'stdio' ? (
        <>
          <Field label={t('agent.conn.form.command')}>
            <input
              className={cn(inputCls, 'font-mono')}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t('agent.conn.form.commandPh')}
              aria-label={t('agent.conn.form.command')}
            />
          </Field>
          <Field label={t('agent.conn.form.args')} hint={t('agent.conn.form.argsHint')}>
            <textarea
              rows={3}
              className={cn(inputCls, 'font-mono')}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={t('agent.conn.form.argsPh')}
              aria-label={t('agent.conn.form.args')}
            />
          </Field>
          <Field
            label={t('agent.conn.form.env')}
            hint={
              initial?.envKeys.length
                ? `${t('agent.conn.form.envHint')} ${t('agent.conn.form.savedKeys', { keys: initial.envKeys.join(', ') })}`
                : t('agent.conn.form.envHint')
            }
          >
            <textarea
              rows={2}
              className={cn(inputCls, 'font-mono')}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder="API_KEY=…"
              aria-label={t('agent.conn.form.env')}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={t('agent.conn.form.url')}>
            <input
              className={cn(inputCls, 'font-mono')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('agent.conn.form.urlPh')}
              aria-label={t('agent.conn.form.url')}
            />
          </Field>
          <Field
            label={t('agent.conn.form.headers')}
            hint={
              initial?.headerKeys.length
                ? `${t('agent.conn.form.headersHint')} ${t('agent.conn.form.savedKeys', { keys: initial.headerKeys.join(', ') })}`
                : t('agent.conn.form.headersHint')
            }
          >
            <textarea
              rows={2}
              className={cn(inputCls, 'font-mono')}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder="Authorization: Bearer …"
              aria-label={t('agent.conn.form.headers')}
            />
          </Field>
        </>
      )}
      <div className="flex items-center gap-2">
        <Button size="md" variant="primary" disabled={!valid || busy} onClick={() => void save()}>
          {busy && <RefreshCw className="animate-spin" />}
          {t('agent.conn.form.save')}
        </Button>
        <Button size="md" variant="ghost" disabled={busy} onClick={() => onDone()}>
          {t('agent.conn.form.cancel')}
        </Button>
      </div>
    </div>
  )
}

/* ——— 外部工具：一个服务器 ——— */

function ServerCard({ s, onEdit }: { s: McpServerInfo; onEdit: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['mcp'] })
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
      refresh()
    }
  }
  const remove = async (): Promise<void> => {
    if (
      !(await confirm({
        title: t('agent.conn.removeTitle', { name: s.name }),
        description: t('agent.conn.removeDesc'),
        danger: true,
        confirmText: t('agent.conn.remove')
      }))
    )
      return
    await run(() => api.mcp.removeServer(s.id))
  }
  const setPolicy = (tool: string, policy: ToolPolicy): void => void run(() => api.mcp.setToolPolicy({ serverId: s.id, tool, policy }))
  return (
    <li className="rounded-xl border border-border bg-surface" data-testid="mcp-server" data-name={s.name}>
      <div className="flex items-center gap-3 px-4 py-3">
        <Server className="size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{s.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
            <span className={cn('inline-block size-2 shrink-0 rounded-full', STATE_DOT[s.state])} />
            <span data-testid="mcp-server-state">{t(`agent.conn.state.${s.state}`)}</span>
            {s.state === 'ready' && <span>· {t('agent.conn.toolCount', { count: s.tools.length })}</span>}
          </p>
          <p
            className="mt-0.5 truncate font-mono text-xs text-subtle"
            title={s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : (s.url ?? '')}
          >
            {s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}
          </p>
        </div>
        <Switch
          checked={s.enabled}
          aria-label={t('agent.conn.enabled')}
          onCheckedChange={(enabled) =>
            void run(() =>
              api.mcp.saveServer({
                id: s.id,
                name: s.name,
                transport: s.transport,
                command: s.command ?? undefined,
                args: s.args,
                url: s.url ?? undefined,
                cwd: s.cwd,
                enabled
              })
            )
          }
        />
      </div>
      {s.error && s.state !== 'ready' && (
        <p className="mx-4 mb-3 rounded-lg bg-danger-soft px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-danger">{s.error}</p>
      )}
      <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
        {s.state === 'ready' && s.tools.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
            <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
            {t('agent.conn.tools')}
          </Button>
        )}
        {s.enabled && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || s.state === 'connecting'}
            onClick={() => void run(() => api.mcp.testServer(s.id))}
          >
            <RefreshCw className={cn(busy && 'animate-spin')} />
            {s.state === 'ready' ? t('agent.conn.reconnect') : t('agent.conn.connect')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil />
          {t('agent.conn.edit')}
        </Button>
        {s.oauth && (
          <Button size="sm" variant="ghost" onClick={() => void run(() => api.mcp.logoutServer(s.id))}>
            <LogOut />
            {t('agent.conn.logout')}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto text-danger hover:text-danger" onClick={() => void remove()}>
          <Trash2 />
          {t('agent.conn.remove')}
        </Button>
      </div>
      {open && (
        <ul className="divide-y divide-border border-t border-border" data-testid="mcp-tools">
          {s.tools.map((tool) => (
            <li key={tool.name} className="flex items-center gap-3 px-4 py-2.5" data-testid="mcp-tool" data-name={tool.name}>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm text-fg">
                  <span className="truncate">{tool.title}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-px text-xs',
                      tool.level === 'read'
                        ? 'bg-sunken text-muted'
                        : tool.level === 'write'
                          ? 'bg-accent-soft text-accent'
                          : 'bg-warning/10 text-warning'
                    )}
                  >
                    {t(`agent.conn.level.${tool.level}`)}
                  </span>
                </p>
                {tool.description && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{tool.description}</p>}
              </div>
              <Choice
                label={tool.title}
                value={tool.policy}
                onChange={(p) => setPolicy(tool.name, p)}
                options={(['auto', 'ask', 'deny'] as ToolPolicy[]).map((p) => ({
                  value: p,
                  label: t(`agent.conn.policy.${p}`),
                  disabled: !allowedPolicies(tool.level).includes(p),
                  hint: !allowedPolicies(tool.level).includes(p) ? t('agent.conn.externalLocked') : undefined
                }))}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/* ——— 让其他应用使用积微 ——— */

function SecretPanel({ secret, onClose }: { secret: McpClientSecret; onClose: () => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState(secret.configs[0].id)
  const [copied, setCopied] = useState(false)
  const cfg = secret.configs.find((c) => c.id === tab)!
  const where: Record<string, string> = {
    'claude-desktop': t('agent.conn.whereClaude'),
    cursor: t('agent.conn.whereCursor'),
    'claude-code': t('agent.conn.whereCode'),
    http: t('agent.conn.whereHttp')
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(cfg.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="space-y-3 rounded-xl border border-accent/35 bg-accent-soft/40 p-4" data-testid="mcp-secret">
      <p className="flex items-center gap-2 text-sm font-medium text-fg">
        <KeyRound className="size-4 text-accent" />
        {t('agent.conn.secretTitle', { name: secret.client.name })}
      </p>
      <p className="text-xs leading-relaxed text-muted">{t('agent.conn.secretHint')}</p>
      <div className="flex flex-wrap gap-1.5">
        {secret.configs.map((c) => (
          <button
            key={c.id}
            onClick={() => setTab(c.id)}
            className={cn(
              'h-7 rounded-full border px-3 text-xs',
              tab === c.id ? 'border-accent bg-surface text-accent' : 'border-border text-muted hover:text-fg'
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted">{where[tab]}</p>
      <div className="relative">
        <pre
          className="max-h-56 overflow-auto rounded-lg border border-border bg-surface p-3 pr-20 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-fg"
          data-testid="mcp-config"
        >
          {cfg.text}
        </pre>
        <Button size="sm" variant="outline" className="absolute top-2 right-2" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? t('agent.conn.copied') : t('agent.conn.copy')}
        </Button>
      </div>
      <Button size="md" variant="primary" onClick={onClose}>
        {t('agent.conn.done')}
      </Button>
    </div>
  )
}

function AccessChoice({ value, onChange }: { value: McpAccess; onChange: (v: McpAccess) => void }) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('agent.conn.access')}>
      {(['read', 'add', 'propose'] as McpAccess[]).map((a) => (
        <button
          key={a}
          role="radio"
          aria-checked={value === a}
          onClick={() => onChange(a)}
          className={cn(
            'rounded-lg border px-3 py-2 text-left transition-colors',
            value === a ? 'border-accent bg-accent-soft/60' : 'border-border bg-surface hover:bg-surface-hover'
          )}
        >
          <span className="block text-sm text-fg">{t(`agent.conn.accessLevel.${a}`)}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">{t(`agent.conn.accessHint.${a}`)}</span>
        </button>
      ))}
    </div>
  )
}

function ClientRow({ c, onSecret }: { c: McpClientInfo; onSecret: (s: McpClientSecret) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['mcp'] })
  const rotate = async (): Promise<void> => {
    if (!(await confirm({ title: t('agent.conn.rotate'), description: t('agent.conn.rotateDesc'), confirmText: t('agent.conn.rotate') })))
      return
    onSecret(await api.mcp.rotateToken(c.id))
  }
  const remove = async (): Promise<void> => {
    if (
      !(await confirm({
        title: t('agent.conn.removeTitle', { name: c.name }),
        description: t('agent.conn.rotateDesc'),
        danger: true,
        confirmText: t('agent.conn.remove')
      }))
    )
      return
    await api.mcp.removeClient(c.id)
    refresh()
  }
  return (
    <li className="py-3" data-testid="mcp-client" data-name={c.name}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{c.name}</p>
          <p className="mt-0.5 text-xs text-muted">
            {!c.enabled
              ? t('agent.conn.disabled')
              : c.lastUsedAt
                ? t('agent.conn.lastUsed', { time: new Date(c.lastUsedAt).toLocaleString() })
                : t('agent.conn.neverUsed')}
          </p>
        </div>
        <Choice
          label={t('agent.conn.access')}
          value={c.access}
          onChange={(access) => void api.mcp.updateClient(c.id, { access }).then(refresh)}
          options={(['read', 'add', 'propose'] as McpAccess[]).map((a) => ({ value: a, label: t(`agent.conn.accessLevel.${a}`) }))}
        />
        <Switch
          checked={c.enabled}
          aria-label={t('agent.conn.enabled')}
          onCheckedChange={(enabled) => void api.mcp.updateClient(c.id, { enabled }).then(refresh)}
        />
      </div>
      <div className="mt-1.5 flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => void rotate()}>
          <KeyRound />
          {t('agent.conn.rotate')}
        </Button>
        <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => void remove()}>
          <Trash2 />
          {t('agent.conn.remove')}
        </Button>
      </div>
    </li>
  )
}

function ServeSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const { data: status } = useQuery({ queryKey: ['mcp', 'serve'], queryFn: () => api.mcp.serveStatus() })
  const { data: clients = [] } = useQuery({ queryKey: ['mcp', 'clients'], queryFn: () => api.mcp.clients() })
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [access, setAccess] = useState<McpAccess>('read')
  const [secret, setSecret] = useState<McpClientSecret | null>(null)
  const [port, setPort] = useState('')
  useEffect(() => setPort(String(s?.mcpServe.port ?? '')), [s?.mcpServe.port])
  if (!s || !status) return null
  const setServe = (patch: Partial<typeof s.mcpServe>): void =>
    update.mutate(
      { mcpServe: { ...s.mcpServe, ...patch } },
      { onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ['mcp'] }), 300) }
    )
  const create = async (): Promise<void> => {
    const r = await api.mcp.createClient({ name: name.trim(), access })
    setSecret(r)
    setAdding(false)
    setName('')
    setAccess('read')
    void qc.invalidateQueries({ queryKey: ['mcp'] })
  }
  return (
    <section className="py-5" data-testid="mcp-serve">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-fg">
            <Cable className="size-4 text-muted" />
            {t('agent.conn.serve')}
          </h3>
          <p className="mt-1 max-w-[460px] text-xs leading-relaxed text-muted">{t('agent.conn.serveHint')}</p>
        </div>
        <Switch checked={s.mcpServe.enabled} aria-label={t('agent.conn.serveOn')} onCheckedChange={(enabled) => setServe({ enabled })} />
      </div>
      {s.mcpServe.enabled && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            {status.listening ? (
              <span className="flex items-center gap-1.5 text-fg">
                <span className="size-2 rounded-full bg-accent" />
                {t('agent.conn.listening')}
              </span>
            ) : (
              status.error && <span className="text-danger">{status.error}</span>
            )}
            <span className="text-xs text-muted">
              {t('agent.conn.address')} <span className="font-mono text-fg">{status.url}</span>
            </span>
            <label className="flex items-center gap-2 text-xs text-muted">
              {t('agent.conn.port')}
              <input
                value={port}
                inputMode="numeric"
                aria-label={t('agent.conn.port')}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                onBlur={() => {
                  const n = Number(port)
                  if (n >= 1024 && n <= 65535 && n !== s.mcpServe.port) setServe({ port: n })
                  else setPort(String(s.mcpServe.port))
                }}
                className="h-7 w-20 rounded-md border border-border bg-surface px-2 font-mono text-xs text-fg outline-none focus:border-accent"
              />
            </label>
          </div>
          {secret && <SecretPanel secret={secret} onClose={() => setSecret(null)} />}
          <div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-fg">{t('agent.conn.clients')}</p>
                <p className="mt-0.5 text-xs text-muted">{t('agent.conn.clientsHint')}</p>
              </div>
              {!adding && (
                <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                  <Plus />
                  {t('agent.conn.addClient')}
                </Button>
              )}
            </div>
            {adding && (
              <div className="mt-3 space-y-3 rounded-xl border border-border bg-sunken/50 p-4" data-testid="mcp-client-form">
                <Field label={t('agent.conn.clientName')}>
                  <input
                    className={inputCls}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('agent.conn.clientNamePh')}
                    aria-label={t('agent.conn.clientName')}
                  />
                </Field>
                <div>
                  <p className="mb-1.5 text-sm text-fg">{t('agent.conn.access')}</p>
                  <AccessChoice value={access} onChange={setAccess} />
                </div>
                <div className="flex gap-2">
                  <Button size="md" variant="primary" disabled={!name.trim()} onClick={() => void create()}>
                    {t('agent.conn.create')}
                  </Button>
                  <Button size="md" variant="ghost" onClick={() => setAdding(false)}>
                    {t('agent.conn.form.cancel')}
                  </Button>
                </div>
              </div>
            )}
            {clients.length ? (
              <ul className="mt-2 divide-y divide-border">
                {clients.map((c) => (
                  <ClientRow key={c.id} c={c} onSecret={setSecret} />
                ))}
              </ul>
            ) : (
              !adding && <p className="mt-3 text-sm text-muted">{t('agent.conn.clientsEmpty')}</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export function ConnectionsSettings() {
  const { t } = useTranslation()
  const { data: servers = [] } = useQuery({ queryKey: ['mcp', 'servers'], queryFn: () => api.mcp.servers() })
  const [editing, setEditing] = useState<McpServerInfo | 'new' | null>(null)
  return (
    <div data-testid="connections-settings">
      <p className="pt-2 text-sm leading-relaxed text-muted">{t('agent.conn.intro')}</p>
      <section className="border-b border-border py-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h3 className="text-sm font-medium text-fg">{t('agent.conn.servers')}</h3>
            <p className="mt-1 max-w-[460px] text-xs leading-relaxed text-muted">{t('agent.conn.serversHint')}</p>
          </div>
          {!editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
              <Plus />
              {t('agent.conn.add')}
            </Button>
          )}
        </div>
        <div className="mt-3 space-y-2">
          {editing && <ServerForm initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}
          {servers.length ? (
            <ul className="space-y-2">
              {servers.map((s) => (
                <ServerCard key={s.id} s={s} onEdit={() => setEditing(s)} />
              ))}
            </ul>
          ) : (
            !editing && <p className="text-sm text-muted">{t('agent.conn.serversEmpty')}</p>
          )}
        </div>
      </section>
      <ServeSection />
      <MailSettings />
    </div>
  )
}
