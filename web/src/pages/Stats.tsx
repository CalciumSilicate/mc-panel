import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type LeaderRow, type StatMetric, getLeaderboard, listStatMetrics, refreshStats } from '@/api/stats'
import { type ServerSummary, listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { Pagination } from '@/components/Pagination'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { usePaged } from '@/lib/use-paged'
import { useResource } from '@/lib/use-resource'
import { fmtRefreshed } from '@/lib/utils'

const MC_TYPES = ['vanilla', 'fabric', 'forge']
const WINDOWS = [
  { key: 'total', label: '累计' },
  { key: '24h', label: '近 24 小时' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
]

function fmtValue(metric: string, v: number): string {
  if (metric === 'play_time') return `${(v / 20 / 3600).toFixed(1)} 小时`
  if (metric === 'walk_one_cm' || metric === 'sprint_one_cm') {
    const m = v / 100
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m.toFixed(0)} m`
  }
  return v.toLocaleString()
}

export default function Stats() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const { data: metrics } = useResource(() => listStatMetrics(), [])
  const mcServers = useMemo<ServerSummary[]>(() => (servers ?? []).filter((s) => MC_TYPES.includes(s.server_type)), [servers])
  const [serverId, setServerId] = useState<number | null>(null)
  const [metric, setMetric] = useState('play_time')
  const [window, setWindow] = useState('total')
  const [rows, setRows] = useState<LeaderRow[]>([])
  const [scannedAt, setScannedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const paged = usePaged(rows, 20)

  useEffect(() => {
    if (serverId === null && mcServers.length > 0) setServerId(mcServers[0].id)
  }, [mcServers, serverId])

  const load = async () => {
    if (serverId === null) return
    setLoading(true)
    try {
      const r = await getLeaderboard(serverId, metric, window)
      setRows(r.rows); setScannedAt(r.scanned_at)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [serverId, metric, window]) // eslint-disable-line react-hooks/exhaustive-deps

  const doRefresh = async () => {
    if (serverId === null) return
    setLoading(true)
    try {
      await refreshStats(serverId)
      await load()
      showToast('success', '已刷新')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '刷新失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <PageShell
      title="数据统计"
      description="基于原版玩家统计(stats)的排行榜:游戏时长、击杀、死亡等。每 10 分钟自动采集。"
      width="5xl"
      actions={
        mcServers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">{fmtRefreshed(scannedAt)}</span>
            <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
              <SelectTrigger className="w-40"><SelectValue placeholder="选择服务器" /></SelectTrigger>
              <SelectContent>{mcServers.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>))}</SelectContent>
            </Select>
            <Select value={metric} onValueChange={setMetric}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{(metrics ?? []).map((m: StatMetric) => (<SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>))}</SelectContent>
            </Select>
            <Select value={window} onValueChange={setWindow}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{WINDOWS.map((w) => (<SelectItem key={w.key} value={w.key}>{w.label}</SelectItem>))}</SelectContent>
            </Select>
            <Button type="button" variant="outline" className="gap-2" onClick={doRefresh} disabled={loading}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />刷新
            </Button>
          </div>
        ) : null
      }
    >
      {mcServers.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有 MC 服务器实例。</p></PageSurface>
      ) : (
        <PageSurface bodyClassName="p-0">
          {loading && rows.length === 0 ? (
            <div className="py-10"><InlineLoader /></div>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无数据(玩家进服游玩后,10 分钟内自动采集)。</p>
          ) : (
            <div className="px-2 pb-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">#</TableHead>
                    <TableHead>玩家</TableHead>
                    <TableHead className="text-right">{metrics?.find((m) => m.key === metric)?.label ?? metric}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.pageItems.map((r, i) => (
                    <TableRow key={r.uuid}>
                      <TableCell className="font-mono text-muted-foreground">{(paged.page - 1) * 20 + i + 1}</TableCell>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-right font-mono">{fmtValue(metric, r.value)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination page={paged.page} pageCount={paged.pageCount} total={paged.total} onPage={paged.setPage} />
            </div>
          )}
        </PageSurface>
      )}
    </PageShell>
  )
}
