import { useEffect, useMemo, useState } from 'react'
import { Globe, Loader2, Network, Plug, Plus, RefreshCw, Server, X, Zap } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type CustomBackend,
  type ServerSummary,
  type WiringStatus,
  addCustomBackend,
  deleteCustomBackend,
  getProxySecret,
  getWiringStatus,
  listCustomBackends,
  listServers,
  updateServer,
  wireProxy,
} from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { ServerLifecycleButton } from '@/components/ServerLifecycleButton'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/dialog-context'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { SERVER_STATUS_META } from '@/lib/server-status'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const TYPE_LABEL: Record<string, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', velocity: 'Velocity' }

function StatusBadge({ s }: { s: ServerSummary }) {
  const meta = SERVER_STATUS_META[s.status]
  return <Badge variant="outline" className={cn('shrink-0 whitespace-nowrap text-[11px]', meta.tone)}>{meta.label}</Badge>
}

export default function ProxyNet() {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const { data, loading, error, refresh } = useResource(() => listServers(), [])
  const [busy, setBusy] = useState<number | null>(null)
  const [wireResults, setWireResults] = useState<Record<number, WiringStatus[]>>({})
  const [secrets, setSecrets] = useState<Record<number, string>>({})
  const [customs, setCustoms] = useState<Record<number, CustomBackend[]>>({})
  // 每个代理的「添加自定义子服」表单草稿
  const [drafts, setDrafts] = useState<Record<number, { name: string; host: string; port: string }>>({})
  const [addingCustom, setAddingCustom] = useState<number | null>(null)

  const proxies = useMemo(() => (data ?? []).filter((s) => s.server_type === 'velocity'), [data])

  useEffect(() => {
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    for (const p of proxies) {
      getWiringStatus(p.id).then((r) => {
        if (!cancelled) setWireResults((cur) => ({ ...cur, [p.id]: r.results }))
      }).catch(() => {
        if (!cancelled) setWireResults((cur) => ({ ...cur, [p.id]: [] }))
      })
    }
    return () => { cancelled = true }
  }, [proxies])

  const reloadCustoms = (proxyId: number) =>
    listCustomBackends(proxyId).then((rows) => setCustoms((cur) => ({ ...cur, [proxyId]: rows }))).catch(() => undefined)

  const randomSecret = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('')

  // 为每个代理拉取/初始化 forwarding secret(无则前端随机生成)
  useEffect(() => {
    for (const p of proxies) {
      if (secrets[p.id] !== undefined) continue
      getProxySecret(p.id).then((s) => setSecrets((cur) => ({ ...cur, [p.id]: s || randomSecret() }))).catch(() => undefined)
    }
  }, [proxies]) // eslint-disable-line react-hooks/exhaustive-deps
  // 拉取每个代理下的自定义子服
  useEffect(() => {
    for (const p of proxies) {
      if (customs[p.id] !== undefined) continue
      reloadCustoms(p.id)
    }
  }, [proxies]) // eslint-disable-line react-hooks/exhaustive-deps

  const draftOf = (proxyId: number) => drafts[proxyId] ?? { name: '', host: '127.0.0.1', port: '25565' }

  const submitCustom = async (proxyId: number) => {
    const d = draftOf(proxyId)
    const name = d.name.trim()
    const host = d.host.trim()
    const port = Number(d.port)
    if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      showToast('error', '请填写子服名、host 与合法端口(1-65535)')
      return
    }
    setAddingCustom(proxyId)
    try {
      await addCustomBackend(proxyId, { name, host, port })
      await reloadCustoms(proxyId)
      setDrafts((cur) => ({ ...cur, [proxyId]: { name: '', host: '127.0.0.1', port: '25565' } }))
      showToast('success', '已添加自定义子服')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '添加失败')
    } finally {
      setAddingCustom(null)
    }
  }

  const removeCustom = async (proxyId: number, backendId: number) => {
    try {
      await deleteCustomBackend(backendId)
      await reloadCustoms(proxyId)
      showToast('success', '已移除')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '移除失败')
    }
  }

  // 可作为子服的(非 velocity)且未挂在任何代理下的
  const unattached = useMemo(
    () => (data ?? []).filter((s) => s.server_type !== 'velocity' && s.proxy_id == null),
    [data],
  )

  const run = async (id: number, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id)
    try {
      await fn()
      showToast('success', ok)
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const wire = async (proxyId: number) => {
    setBusy(proxyId)
    try {
      // Re-read lifecycle state at the explicit user operation, not just the last poll.
      const servers = await listServers()
      const involved = servers.filter((s) => s.id === proxyId || s.proxy_id === proxyId)
      if (involved.some((s) => s.protected || s.status === 'installing' || s.status === 'queued')) {
        showToast('error', '受保护、安装中或启动排队中的实例不可接线')
        return
      }
      const active = involved.filter((s) => s.status === 'running' || s.status === 'starting')
      const force = active.length > 0
      if (force && !await confirm({
        title: '强制接线 (FORCE WIRING)',
        description: `将强制停止 ${active.map((s) => s.name).join('、')} 及其子进程。未保存的数据可能丢失！确认退出后才写入配置，接线后不会自动重启。`,
        confirmText: '强制停止并接线',
        destructive: true,
      })) return
      setWireResults((cur) => ({ ...cur, [proxyId]: [] }))
      const r = await wireProxy(proxyId, secrets[proxyId] ?? '', force)
      const bad = r.results.filter((x) => x.status !== 'ok' && x.status !== 'skipped').length
      showToast(bad ? 'error' : 'success', bad ? `完成,${bad} 个子服需注意` : '接线完成')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '接线失败')
    } finally {
      refresh()
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="代理网络"
      description="把 MC 子服挂到 Velocity 主服下,一键配置 modern 转发(Fabric/Forge 自动装转发 mod);自定义子服(外部服务器)仅加入路由,接线时跳过。"
      width="6xl"
      actions={
        <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          刷新
        </Button>
      }
    >
      {error ? (
        <PageSurface><p className="py-8 text-center text-sm text-destructive">{error}</p></PageSurface>
      ) : loading && !data ? (
        <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
      ) : proxies.length === 0 ? (
        <PageSurface>
          <p className="py-10 text-center text-sm text-muted-foreground">
            还没有 Velocity 实例。先在「服务器实例」新建一个 Velocity 作为代理主服。
          </p>
        </PageSurface>
      ) : (
        <div className="space-y-5">
          {proxies.map((proxy) => {
            const backends = (data ?? []).filter((s) => s.proxy_id === proxy.id)
            const proxyCustoms = customs[proxy.id] ?? []
            const results = wireResults[proxy.id] ?? []
            const draft = draftOf(proxy.id)
            return (
              <PageSurface key={proxy.id} bodyClassName="p-0">
                {/* 主服节点 */}
                <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-4 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                    <Network className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-full truncate font-semibold sm:w-auto" title={proxy.name}>{proxy.name}</span>
                      <Badge variant="outline" className="shrink-0 whitespace-nowrap text-[11px]">主服 · Velocity</Badge>
                      <StatusBadge s={proxy} />
                    </div>
                    <div className="text-xs text-muted-foreground">端口 {proxy.port} · {backends.length + proxyCustoms.length} 个子服</div>
                  </div>
                  <ServerLifecycleButton server={proxy} onChanged={refresh} />
                  {/* forwarding secret(固定宽度,靠近接线按钮)*/}
                  <div className="hidden shrink-0 items-center gap-2 lg:flex">
                    <span className="shrink-0 text-xs text-muted-foreground">转发密钥</span>
                    <Input
                      value={secrets[proxy.id] ?? ''}
                      placeholder="加载中…"
                      className="h-8 w-56 font-mono text-xs"
                      onChange={(e) => setSecrets((cur) => ({ ...cur, [proxy.id]: e.target.value }))}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => setSecrets((cur) => ({ ...cur, [proxy.id]: randomSecret() }))}>
                      随机
                    </Button>
                  </div>
                  <Button type="button" className="w-full gap-1.5 shrink-0 sm:w-auto" disabled={busy === proxy.id || (backends.length === 0 && proxyCustoms.length === 0)} onClick={() => wire(proxy.id)}>
                    {busy === proxy.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                    一键接线
                  </Button>
                </div>

                {/* 子服 */}
                <div className="space-y-2 px-4 py-3">
                  {backends.length === 0 && proxyCustoms.length === 0 ? (
                    <p className="py-2 text-center text-xs text-muted-foreground">还没有子服。</p>
                  ) : (
                    <>
                      {backends.map((b) => {
                        const res = results.find((r) => !r.custom && r.id === b.id)
                        return (
                          <div key={b.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                            <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-[1_1_80%] truncate text-sm font-medium sm:flex-1" title={b.name}>{b.name}</span>
                            <Badge variant="outline" className="text-[11px]">{TYPE_LABEL[b.server_type] ?? b.server_type}</Badge>
                            <span className="font-mono text-xs text-muted-foreground">:{b.port}</span>
                            <StatusBadge s={b} />
                            <ServerLifecycleButton server={b} onChanged={refresh} />
                            {res ? (
                              <span className={cn('max-w-[40%] truncate text-[11px]', res.status === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : res.status === 'unsupported' ? 'text-amber-600 dark:text-amber-400' : 'text-destructive')} title={res.detail}>
                                {res.detail}
                              </span>
                            ) : <span className="text-[11px] text-muted-foreground">接线状态未验证</span>}
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" title="移出代理" disabled={busy === b.id} onClick={() => run(b.id, () => updateServer(b.id, { proxy_id: null }), '已移出')}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        )
                      })}
                      {proxyCustoms.map((c) => {
                        const res = results.find((r) => r.custom && r.id === c.id)
                        return (
                          <div key={`custom-${c.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border/70 bg-background/40 px-3 py-2">
                            <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-[1_1_80%] truncate text-sm font-medium sm:flex-1" title={c.name}>{c.name}</span>
                            <Badge variant="outline" className="text-[11px]">自定义</Badge>
                            <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{c.host}:{c.port}</span>
                            {res ? (
                              <span className={cn('max-w-[40%] truncate text-[11px]', res.status === 'skipped' ? 'text-sky-600 dark:text-sky-400' : res.status === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')} title={res.detail}>
                                {res.detail}
                              </span>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">路由未验证;远端配置未验证</span>
                            )}
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" title="移除自定义子服" onClick={() => removeCustom(proxy.id, c.id)}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        )
                      })}
                    </>
                  )}

                  {/* 添加托管子服 */}
                  {unattached.length > 0 ? (
                    <div className="flex items-center gap-2 pt-1">
                      <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <Select
                        value={undefined}
                        onValueChange={(v) => run(Number(v), () => updateServer(Number(v), { proxy_id: proxy.id }), '已加入')}
                      >
                        <SelectTrigger className="h-8 min-w-0 flex-1 sm:w-56 sm:flex-none"><SelectValue placeholder="添加托管子服…" /></SelectTrigger>
                        <SelectContent>
                          {unattached.map((s) => (
                            <SelectItem key={s.id} value={String(s.id)}>
                              {s.name}（{TYPE_LABEL[s.server_type] ?? s.server_type}）
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}

                  {/* 添加自定义子服(外部服务器:名字 / host / 端口,接线时跳过) */}
                  <div className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 border-t border-border/70 pt-3 sm:flex sm:flex-wrap">
                    <Globe className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
                    <Input
                      value={draft.name}
                      placeholder="子服名"
                      aria-label="子服名"
                      className="col-span-2 h-8 min-w-0 sm:w-32"
                      onChange={(e) => setDrafts((cur) => ({ ...cur, [proxy.id]: { ...draftOf(proxy.id), name: e.target.value } }))}
                    />
                    <Input
                      value={draft.host}
                      placeholder="host(如 mc.example.com)"
                      aria-label="子服地址"
                      className="h-8 min-w-0 sm:w-52"
                      onChange={(e) => setDrafts((cur) => ({ ...cur, [proxy.id]: { ...draftOf(proxy.id), host: e.target.value } }))}
                    />
                    <Input
                      value={draft.port}
                      placeholder="端口"
                      inputMode="numeric"
                      aria-label="子服端口"
                      className="h-8 min-w-0 sm:w-20"
                      onChange={(e) => setDrafts((cur) => ({ ...cur, [proxy.id]: { ...draftOf(proxy.id), port: e.target.value } }))}
                    />
                    <Button type="button" variant="outline" size="sm" className="col-span-2 gap-1.5" disabled={addingCustom === proxy.id} onClick={() => submitCustom(proxy.id)}>
                      {addingCustom === proxy.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      添加自定义子服
                    </Button>
                  </div>
                </div>
              </PageSurface>
            )
          })}
        </div>
      )}
    </PageShell>
  )
}
