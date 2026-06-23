import { useMemo, useState } from 'react'
import { Loader2, Network, Plug, RefreshCw, Server, X, Zap } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type ServerSummary, type WireResult, listServers, updateServer, wireProxy } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { SERVER_STATUS_META } from '@/lib/server-status'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const TYPE_LABEL: Record<string, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', velocity: 'Velocity' }

function StatusBadge({ s }: { s: ServerSummary }) {
  const meta = SERVER_STATUS_META[s.status]
  return <Badge variant="outline" className={cn('text-[11px]', meta.tone)}>{meta.label}</Badge>
}

export default function ProxyNet() {
  const { showToast } = useGlobalToast()
  const { data, loading, error, refresh } = useResource(() => listServers(), [])
  const [busy, setBusy] = useState<number | null>(null)
  const [wireResults, setWireResults] = useState<Record<number, WireResult[]>>({})

  const proxies = useMemo(() => (data ?? []).filter((s) => s.server_type === 'velocity'), [data])
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
      const r = await wireProxy(proxyId)
      setWireResults((cur) => ({ ...cur, [proxyId]: r.results }))
      const bad = r.results.filter((x) => x.status !== 'ok').length
      showToast(bad ? 'error' : 'success', bad ? `完成,${bad} 个子服需注意` : '接线完成')
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '接线失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="代理网络"
      description="把 MC 子服挂到 Velocity 主服下,一键配置 modern 转发(Fabric/Forge 自动装转发 mod)。"
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
            const results = wireResults[proxy.id] ?? []
            return (
              <PageSurface key={proxy.id} bodyClassName="p-0">
                {/* 主服节点 */}
                <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
                    <Network className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{proxy.name}</span>
                      <Badge variant="outline" className="text-[11px]">主服 · Velocity</Badge>
                      <StatusBadge s={proxy} />
                    </div>
                    <div className="text-xs text-muted-foreground">端口 {proxy.port} · {backends.length} 个子服</div>
                  </div>
                  <Button type="button" className="gap-1.5" disabled={busy === proxy.id || backends.length === 0} onClick={() => wire(proxy.id)}>
                    {busy === proxy.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                    一键接线
                  </Button>
                </div>

                {/* 子服 */}
                <div className="space-y-2 px-4 py-3">
                  {backends.length === 0 ? (
                    <p className="py-2 text-center text-xs text-muted-foreground">还没有子服。</p>
                  ) : (
                    backends.map((b) => {
                      const res = results.find((r) => r.name === b.name)
                      return (
                        <div key={b.id} className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                          <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.name}</span>
                          <Badge variant="outline" className="text-[11px]">{TYPE_LABEL[b.server_type] ?? b.server_type}</Badge>
                          <span className="font-mono text-xs text-muted-foreground">:{b.port}</span>
                          <StatusBadge s={b} />
                          {res ? (
                            <span className={cn('max-w-[40%] truncate text-[11px]', res.status === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : res.status === 'unsupported' ? 'text-amber-600 dark:text-amber-400' : 'text-destructive')} title={res.detail}>
                              {res.detail}
                            </span>
                          ) : null}
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" title="移出代理" disabled={busy === b.id} onClick={() => run(b.id, () => updateServer(b.id, { proxy_id: null }), '已移出')}>
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      )
                    })
                  )}

                  {/* 添加子服 */}
                  {unattached.length > 0 ? (
                    <div className="flex items-center gap-2 pt-1">
                      <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <Select
                        value={undefined}
                        onValueChange={(v) => run(Number(v), () => updateServer(Number(v), { proxy_id: proxy.id }), '已加入')}
                      >
                        <SelectTrigger className="h-8 w-56"><SelectValue placeholder="添加子服…" /></SelectTrigger>
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
                </div>
              </PageSurface>
            )
          })}
        </div>
      )}
    </PageShell>
  )
}
