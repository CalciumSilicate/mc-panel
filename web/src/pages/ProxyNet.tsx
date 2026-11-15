import { useEffect, useMemo, useState } from 'react'
import { Globe, Loader2, Network, Plug, Plus, RefreshCw, Server, Settings2, ChevronDown, X, Zap } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type CustomBackend,
  type ServerSummary,
  type WiringStatus,
  type WireResult,
  addCustomBackend,
  configureJoinMotd,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/dialog-context'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
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

function WiringDetail({ result, external = false }: { result?: WiringStatus; external?: boolean }) {
  if (!result) return <span className="text-xs text-muted-foreground">未验证</span>
  const ok = result.status === 'ok'
  const manual = result.status === 'unsupported' || result.status === 'skipped'
  return <details className="max-w-72 text-xs">
    <summary className={cn('flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden', ok ? 'text-muted-foreground' : manual ? 'text-muted-foreground' : 'text-destructive')}>
      {ok ? '已验证' : manual ? '需手动配置' : '需检查'}<ChevronDown className="h-3 w-3" />
    </summary>
    <p className="mt-2 leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{result.detail}{external && ' 远端配置与运行状态未验证。'}</p>
  </details>
}

export default function ProxyNet() {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const { data, loading, refreshing, error, refresh } = useResource(() => listServers(), [])
  const [selectedProxy, setSelectedProxy] = useState<number | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [wireResults, setWireResults] = useState<Record<number, WiringStatus[]>>({})
  const [secrets, setSecrets] = useState<Record<number, string>>({})
  const [visibleSecrets, setVisibleSecrets] = useState<Record<number, boolean>>({})
  const [customs, setCustoms] = useState<Record<number, CustomBackend[]>>({})
  // 每个代理的「添加自定义子服」表单草稿
  const [drafts, setDrafts] = useState<Record<number, { name: string; host: string; port: string }>>({})
  const [addingCustom, setAddingCustom] = useState<number | null>(null)
  const [motdBusy, setMotdBusy] = useState<number | null>(null)
  const [motdResults, setMotdResults] = useState<Record<number, WireResult[]>>({})

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

  const configureMotd = async (proxy: ServerSummary) => {
    if (!await confirm({
      title: '一键配置 joinMOTD',
      description: `为「${proxy.name}」下的托管子服补装 joinMOTD，覆盖欢迎名称、网络名称和跨服列表，保留开服日期等其他配置。运行中的子服将发送插件加载/重载命令，不重启游戏服。受保护、禁用插件或引用公共配置的子服不会修改；自定义子服仅加入列表。请确保已接线，玩家可使用 /server 命令。`,
      confirmText: '安装并配置',
    })) return
    setMotdBusy(proxy.id)
    setMotdResults((cur) => ({ ...cur, [proxy.id]: [] }))
    try {
      const { results } = await configureJoinMotd(proxy.id)
      setMotdResults((cur) => ({ ...cur, [proxy.id]: results }))
      const failed = results.filter((r) => r.status === 'error').length
      showToast(failed ? 'error' : 'success', failed ? `${failed} 个子服配置失败，请查看结果` : 'joinMOTD 配置完成')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : 'joinMOTD 配置失败')
    } finally {
      setMotdBusy(null)
    }
  }

  return (
    <PageShell
      title="代理网络"
      description="查看代理入口、子服路由与转发配置"
      width="7xl"
      headerClassName="[&>div:first-child]:basis-auto"
      actions={
        <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
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
        <div className="min-w-0 space-y-5">
          {proxies.filter(p => p.id === (proxies.some(entry => entry.id === selectedProxy) ? selectedProxy : proxies[0]?.id)).map((proxy) => {
            const backends = (data ?? []).filter((s) => s.proxy_id === proxy.id)
            const proxyCustoms = customs[proxy.id] ?? []
            const results = wireResults[proxy.id] ?? []
            const draft = draftOf(proxy.id)
            return (
              <section key={proxy.id} className="min-w-0">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Select value={String(proxy.id)} onValueChange={value => { setSelectedProxy(Number(value)); setConfigOpen(false); setAddOpen(false) }}>
                      <SelectTrigger aria-label="选择代理" className="w-56"><div className="flex min-w-0 items-center gap-2"><Network className="h-4 w-4 shrink-0 text-muted-foreground" /><SelectValue /></div></SelectTrigger>
                      <SelectContent>{proxies.map(entry => <SelectItem key={entry.id} value={String(entry.id)}>{entry.name}</SelectItem>)}</SelectContent>
                    </Select>
                    <StatusBadge s={proxy} />
                    <span className="text-xs text-muted-foreground">Velocity · <span className="font-mono">:{proxy.port}</span></span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ServerLifecycleButton server={proxy} onChanged={refresh} />
                    <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}><Settings2 className="h-4 w-4" />网络配置</Button>
                    <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" />添加子服</Button>
                  </div>
                </div>

                <Dialog open={configOpen} onOpenChange={setConfigOpen}>
                  <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader><DialogTitle>网络配置 · {proxy.name}</DialogTitle><DialogDescription>管理转发密钥、接线与入服欢迎消息。</DialogDescription></DialogHeader>
                  <div className="space-y-5 px-4 pb-5 sm:px-5">
                    <section className="space-y-3 border-t border-border/70 pt-4">
                      <h3 className="text-sm font-medium">转发与接线</h3>
                      <p className="text-xs leading-relaxed text-muted-foreground">密钥将在一键接线时写入配置。接线会修改磁盘配置；运行中的实例需确认强制停止，完成后不会自动重启。</p>
                      <label htmlFor={`proxy-secret-${proxy.id}`} className="block text-xs text-muted-foreground">转发密钥</label>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Input
                          id={`proxy-secret-${proxy.id}`}
                          type={visibleSecrets[proxy.id] ? 'text' : 'password'}
                          value={secrets[proxy.id] ?? ''}
                          placeholder="加载中…"
                          autoComplete="off"
                          className="h-9 min-w-0 w-full font-mono text-sm sm:w-auto sm:flex-1"
                          onChange={(e) => setSecrets((cur) => ({ ...cur, [proxy.id]: e.target.value }))}
                        />
                        <Button type="button" variant="outline" size="sm" aria-label={visibleSecrets[proxy.id] ? '隐藏转发密钥' : '显示转发密钥'} aria-pressed={!!visibleSecrets[proxy.id]} onClick={() => setVisibleSecrets((cur) => ({ ...cur, [proxy.id]: !cur[proxy.id] }))}>
                          {visibleSecrets[proxy.id] ? '隐藏' : '显示'}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setSecrets((cur) => ({ ...cur, [proxy.id]: randomSecret() }))}>
                          随机密钥
                        </Button>
                      </div>
                      <Button type="button" className="w-full gap-1.5 shrink-0 sm:w-auto" disabled={motdBusy !== null || busy === proxy.id || (backends.length === 0 && proxyCustoms.length === 0)} onClick={() => wire(proxy.id)}>
                        {busy === proxy.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                        一键接线
                      </Button>
                    </section>

                    <section className="space-y-3 border-t border-border/70 pt-4">
                      <h3 className="text-sm font-medium">入服欢迎 · joinMOTD</h3>
                      <div className="space-y-3">
                        <p className="text-xs leading-relaxed text-muted-foreground">同步入服欢迎消息与可点击跨服列表；网络增删子服后需再次配置。</p>
                        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={busy !== null || motdBusy !== null || proxy.protected || backends.length === 0} onClick={() => configureMotd(proxy)}>
                          {motdBusy === proxy.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                          {motdBusy === proxy.id ? '正在安装并配置…' : '一键配置 joinMOTD'}
                        </Button>
                      </div>
                      {motdResults[proxy.id]?.map((r, i) => (
                        <p key={i} className={cn('break-words text-xs [overflow-wrap:anywhere]', r.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                          <span className="font-medium">{r.name}</span>：{r.detail}
                        </p>
                      ))}
                    </section>
                  </div>
                  </DialogContent>
                </Dialog>

                <div>
                  <PageSurface bodyClassName="p-0">
                    <div className="ops-table-shell border-0">
                      <Table>
                        <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>类型</TableHead><TableHead>地址 / 端口</TableHead><TableHead>状态</TableHead><TableHead>接线配置</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {backends.map(b => <TableRow key={b.id}>
                            <TableCell className="font-medium">{b.name}</TableCell>
                            <TableCell><Badge variant="outline" className="text-[11px]">{TYPE_LABEL[b.server_type] ?? b.server_type}</Badge></TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{b.port}</TableCell>
                            <TableCell><StatusBadge s={b} /></TableCell>
                            <TableCell><WiringDetail result={results.find(r => !r.custom && r.id === b.id)} /></TableCell>
                            <TableCell><div className="flex items-center justify-end gap-2">
                              <ServerLifecycleButton server={b} onChanged={refresh} />
                              <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="移出代理" aria-label={`将 ${b.name} 移出代理`} disabled={busy === b.id} onClick={() => run(b.id, () => updateServer(b.id, { proxy_id: null }), '已移出')}><X className="h-4 w-4" /></Button>
                            </div></TableCell>
                          </TableRow>)}
                          {proxyCustoms.map(c => <TableRow key={`custom-${c.id}`}>
                            <TableCell className="font-medium">{c.name}</TableCell>
                            <TableCell><Badge variant="outline" className="text-[11px]">外部子服</Badge></TableCell>
                            <TableCell className="max-w-64 break-all font-mono text-xs text-muted-foreground">{c.host}:{c.port}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">未监测</TableCell>
                            <TableCell><WiringDetail external result={results.find(r => r.custom && r.id === c.id)} /></TableCell>
                            <TableCell className="text-right"><Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="移除自定义子服" aria-label={`移除外部子服 ${c.name}`} onClick={() => removeCustom(proxy.id, c.id)}><X className="h-4 w-4" /></Button></TableCell>
                          </TableRow>)}
                          {!backends.length && !proxyCustoms.length && <TableRow><TableCell colSpan={6} className="py-14 text-center text-muted-foreground">暂无子服，点击「添加子服」连接服务器。</TableCell></TableRow>}
                        </TableBody>
                      </Table>
                    </div>
                  </PageSurface>
                  <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{backends.length} 个托管子服 · {proxyCustoms.length} 个外部子服</span><span>配置验证不代表实际连接状态</span></div>

                  <Dialog open={addOpen} onOpenChange={setAddOpen}>
                    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
                      <DialogHeader><DialogTitle>添加子服</DialogTitle><DialogDescription>将已有实例或外部服务器加入 {proxy.name}。</DialogDescription></DialogHeader>
                    <div className="space-y-4 pt-4">
                      {/* 添加托管子服 */}
                      <h4 className="text-xs font-medium text-muted-foreground">托管子服</h4>
                      {unattached.length > 0 ? (
                        <div className="flex items-center gap-2 pt-1">
                          <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <Select
                            value={undefined}
                            onValueChange={(v) => run(Number(v), () => updateServer(Number(v), { proxy_id: proxy.id }), '已加入')}
                          >
                            <SelectTrigger aria-label="选择托管子服加入网络" className="h-8 min-w-0 flex-1 sm:w-56 sm:flex-none"><SelectValue placeholder="添加托管子服…" /></SelectTrigger>
                            <SelectContent>
                              {unattached.map((s) => (
                                <SelectItem key={s.id} value={String(s.id)}>
                                  {s.name}（{TYPE_LABEL[s.server_type] ?? s.server_type}）
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : <p className="text-xs text-muted-foreground">暂无可添加的托管子服。</p>}

                      {/* 添加自定义子服(外部服务器:名字 / host / 端口,接线时跳过) */}
                      <div className="space-y-3 border-t border-border/70 pt-4">
                        <h4 className="text-xs font-medium text-muted-foreground">外部子服</h4>
                        <p className="text-xs leading-relaxed text-muted-foreground">仅添加代理路由，远端服务器需手动配置转发。</p>
                        <div className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 sm:flex sm:flex-wrap">
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
                    </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </section>
            )
          })}
        </div>
      )}
    </PageShell>
  )
}
