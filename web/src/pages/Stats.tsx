import { useEffect, useMemo, useState } from 'react'
import { BarChart3, RefreshCw, Search } from 'lucide-react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { ApiError } from '@/api/client'
import {
  type LeaderRow,
  type StatMetric,
  type StatPlayer,
  getLeaderboard,
  getStatSeries,
  listStatMetrics,
  listStatPlayers,
  refreshStats,
} from '@/api/stats'
import { type ServerSummary, listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { Pagination } from '@/components/Pagination'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { usePaged } from '@/lib/use-paged'
import { useResource } from '@/lib/use-resource'
import { cn, fmtRefreshed } from '@/lib/utils'

const MC_TYPES = ['vanilla', 'fabric', 'forge']
const WINDOWS = [
  { key: 'total', label: '累计' },
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: '1y', label: '1 年' },
]
const GRANULARITIES = ['10min', '20min', '30min', '1h', '6h', '12h', '24h']
const HOURS = [
  { key: 24, label: '24 小时' },
  { key: 168, label: '7 天' },
  { key: 720, label: '30 天' },
  { key: 8760, label: '1 年' },
]
const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#be185d']

function fmtValue(metric: string, v: number): string {
  if (metric.includes('play_time') || metric.includes('play_one_minute')) return `${(v / 20 / 3600).toFixed(1)} 小时`
  if (metric.includes('one_cm')) {
    const m = v / 100
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m.toFixed(0)} m`
  }
  return v.toLocaleString()
}

function metricTone(type: string) {
  if (type === 'important') return 'border-blue-500/40 text-blue-600 dark:text-blue-400'
  if (type === 'ignored') return 'border-muted-foreground/30 text-muted-foreground'
  return 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
}

function toggleValue(list: string[], value: string, max = 8) {
  if (list.includes(value)) return list.filter((v) => v !== value)
  return [...list, value].slice(-max)
}

export default function Stats() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const mcServers = useMemo<ServerSummary[]>(() => (servers ?? []).filter((s) => MC_TYPES.includes(s.server_type)), [servers])
  const [serverId, setServerId] = useState<number | null>(null)
  const [metricCategory, setMetricCategory] = useState('all')
  const [metricQuery, setMetricQuery] = useState('')
  const [metrics, setMetrics] = useState<StatMetric[]>([])
  const [players, setPlayers] = useState<StatPlayer[]>([])
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(['custom.play_time'])
  const [selectedPlayers, setSelectedPlayers] = useState<string[]>([])
  const [window, setWindow] = useState('total')
  const [granularity, setGranularity] = useState('10min')
  const [hours, setHours] = useState(24)
  const [mode, setMode] = useState<'delta' | 'total'>('delta')
  const [rows, setRows] = useState<LeaderRow[]>([])
  const [series, setSeries] = useState<Record<string, [number, number][]>>({})
  const [scannedAt, setScannedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const paged = usePaged(rows, 20)

  useEffect(() => {
    if (serverId === null && mcServers.length > 0) setServerId(mcServers[0].id)
  }, [mcServers, serverId])

  useEffect(() => {
    listStatMetrics(metricCategory, metricQuery).then(setMetrics).catch(() => setMetrics([]))
  }, [metricCategory, metricQuery])

  useEffect(() => {
    if (serverId === null) return
    listStatPlayers(serverId).then((r) => {
      setPlayers(r.players)
      setSelectedPlayers((cur) => cur.filter((u) => r.players.some((p) => p.uuid === u)))
    }).catch(() => setPlayers([]))
  }, [serverId])

  const metricLabel = (key: string) => metrics.find((m) => m.key === key)?.label ?? key
  const playerName = (uuid: string) => players.find((p) => p.uuid === uuid)?.name ?? uuid.slice(0, 8)

  const chartData = useMemo(() => {
    const byTs: Record<number, Record<string, number | string>> = {}
    Object.entries(series).forEach(([uuid, pts]) => {
      pts.forEach(([ts, value]) => {
        const key = Math.floor(ts)
        byTs[key] = byTs[key] || { ts: key }
        byTs[key][uuid] = value
      })
    })
    return Object.values(byTs).sort((a, b) => Number(a.ts) - Number(b.ts))
  }, [series])

  const load = async () => {
    if (serverId === null || selectedMetrics.length === 0) return
    setLoading(true)
    try {
      const lb = await getLeaderboard(serverId, selectedMetrics, window)
      setRows(lb.rows); setScannedAt(lb.scanned_at)
      const picked = selectedPlayers.length > 0 ? selectedPlayers : lb.rows.slice(0, 5).map((r) => r.uuid)
      if (picked.length > 0) {
        const sr = await getStatSeries({ serverId, uuids: picked, metrics: selectedMetrics, mode, granularity, hours })
        setSeries(sr.points)
      } else {
        setSeries({})
      }
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [serverId, selectedMetrics, selectedPlayers, window, mode, granularity, hours]) // eslint-disable-line react-hooks/exhaustive-deps

  const doRefresh = async (scope: 'important' | 'full') => {
    if (serverId === null) return
    setLoading(true)
    try {
      await refreshStats(serverId, scope)
      await Promise.all([
        listStatMetrics(metricCategory, metricQuery).then(setMetrics),
        listStatPlayers(serverId).then((r) => setPlayers(r.players)),
      ])
      await load()
      showToast('success', scope === 'full' ? '全量采集完成' : '高频指标已刷新')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '刷新失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <PageShell
      title="数据统计"
      description="重点指标每 10 分钟对齐采集，全量指标每 1 小时对齐采集；运行中实例会先保存 stats。"
      width="7xl"
      actions={mcServers.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">{fmtRefreshed(scannedAt)}</span>
          <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
            <SelectTrigger className="w-40"><SelectValue placeholder="选择服务器" /></SelectTrigger>
            <SelectContent>{mcServers.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>))}</SelectContent>
          </Select>
          <Button type="button" variant="outline" className="gap-2" onClick={() => doRefresh('important')} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />10 分钟
          </Button>
          <Button type="button" variant="outline" className="gap-2" onClick={() => doRefresh('full')} disabled={loading}>
            <BarChart3 className="h-4 w-4" />全量
          </Button>
        </div>
      ) : null}
    >
      {mcServers.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有 MC 服务实例。</p></PageSurface>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <PageSurface bodyClassName="space-y-4">
            <div className="space-y-2">
              <div className="flex gap-2">
                <Select value={metricCategory} onValueChange={setMetricCategory}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部指标</SelectItem>
                    <SelectItem value="important">高频采样</SelectItem>
                    <SelectItem value="normal">白名单</SelectItem>
                    <SelectItem value="ignored">黑名单</SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input value={metricQuery} onChange={(e) => setMetricQuery(e.target.value)} placeholder="搜索指标" className="pl-8" />
                </div>
              </div>
              <div className="max-h-72 overflow-auto rounded-md border">
                {metrics.map((m) => (
                  <label key={m.key} className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0">
                    <Checkbox checked={selectedMetrics.includes(m.key)} onCheckedChange={() => setSelectedMetrics((cur) => toggleValue(cur, m.key, 6))} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{m.label}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">{m.key}</span>
                    </span>
                    <Badge variant="outline" className={cn('text-[11px]', metricTone(m.sample_type))}>{m.sample_type}</Badge>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">玩家</p>
              <div className="max-h-64 overflow-auto rounded-md border">
                {players.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">暂无玩家数据</p>
                ) : players.map((p) => (
                  <label key={p.uuid} className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0">
                    <Checkbox checked={selectedPlayers.includes(p.uuid)} onCheckedChange={() => setSelectedPlayers((cur) => toggleValue(cur, p.uuid, 8))} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">{p.uuid}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </PageSurface>

          <div className="space-y-4">
            <PageSurface bodyClassName="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={mode} onValueChange={(v) => setMode(v as 'delta' | 'total')}>
                    <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="delta">增量</SelectItem>
                      <SelectItem value="total">累计</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={granularity} onValueChange={setGranularity}>
                    <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>{GRANULARITIES.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={String(hours)} onValueChange={(v) => setHours(Number(v))}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>{HOURS.map((h) => <SelectItem key={h.key} value={String(h.key)}>{h.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap gap-1">
                  {selectedMetrics.map((m) => <Badge key={m} variant="outline" className="text-[11px]">{metricLabel(m)}</Badge>)}
                </div>
              </div>
              {loading && chartData.length === 0 ? (
                <div className="py-10"><InlineLoader /></div>
              ) : chartData.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">暂无趋势数据，等待下一次采集或手动刷新。</p>
              ) : (
                <div className="h-[340px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ left: 10, right: 18, top: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="ts" tickFormatter={(v) => new Date(Number(v) * 1000).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} minTickGap={32} />
                      <YAxis tickFormatter={(v) => Number(v).toLocaleString()} width={70} />
                      <Tooltip labelFormatter={(v) => new Date(Number(v) * 1000).toLocaleString()} formatter={(v) => Number(v).toLocaleString()} />
                      <Legend />
                      {Object.keys(series).map((uuid, i) => (
                        <Line key={uuid} type="monotone" dataKey={uuid} name={playerName(uuid)} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </PageSurface>

            <PageSurface bodyClassName="p-0">
              <Tabs value={window} onValueChange={setWindow}>
                <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
                  <TabsList>{WINDOWS.map((w) => <TabsTrigger key={w.key} value={w.key}>{w.label}</TabsTrigger>)}</TabsList>
                  <span className="text-xs text-muted-foreground">排行榜按选中指标求和</span>
                </div>
                {WINDOWS.map((w) => (
                  <TabsContent key={w.key} value={w.key} className="m-0">
                    {loading && rows.length === 0 ? (
                      <div className="py-10"><InlineLoader /></div>
                    ) : rows.length === 0 ? (
                      <p className="py-10 text-center text-sm text-muted-foreground">暂无排行榜数据。</p>
                    ) : (
                      <div className="px-2 pb-2">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-16">#</TableHead>
                              <TableHead>玩家</TableHead>
                              <TableHead className="text-right">数值</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {paged.pageItems.map((r, i) => (
                              <TableRow key={r.uuid}>
                                <TableCell className="font-mono text-muted-foreground">{(paged.page - 1) * 20 + i + 1}</TableCell>
                                <TableCell>
                                  <button type="button" className="font-medium hover:underline" onClick={() => setSelectedPlayers((cur) => toggleValue(cur, r.uuid, 8))}>{r.name}</button>
                                </TableCell>
                                <TableCell className="text-right font-mono">{fmtValue(selectedMetrics[0] ?? '', r.value)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                        <Pagination page={paged.page} pageCount={paged.pageCount} total={paged.total} onPage={paged.setPage} />
                      </div>
                    )}
                  </TabsContent>
                ))}
              </Tabs>
            </PageSurface>
          </div>
        </div>
      )}
    </PageShell>
  )
}
