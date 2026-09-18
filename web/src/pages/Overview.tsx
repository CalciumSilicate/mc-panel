import { useEffect, useState } from 'react'
import { Activity, Archive, ArrowRight, CheckCircle2, Cpu, HardDrive, MemoryStick, RefreshCw, Server, TriangleAlert } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { getDashboardOverview } from '@/api/system'
import type { ServerStatus } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageStat, PageStatStrip, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SERVER_STATUS_META } from '@/lib/server-status'
import { cn } from '@/lib/utils'
import { useResource } from '@/lib/use-resource'

type Destination = 'servers' | 'archives'
type Sample = { time: number; cpu: number | null; memory: number | null }
const ACTIVE_STATES: ServerStatus[] = ['starting', 'queued', 'installing']
const STATUS_ORDER: ServerStatus[] = ['running', 'starting', 'queued', 'installing', 'stopped', 'new_setup', 'error']

function asDate(value: string | number) {
  // SQLite stores UTC datetimes without a timezone suffix.
  return new Date(typeof value === 'string' && !/(Z|[+-]\d{2}:\d{2})$/.test(value) ? `${value}Z` : value)
}

function formatTime(value: string | number) {
  return asDate(value).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function uptime(seconds: number) {
  const days = Math.floor(seconds / 86400)
  return `${days ? `${days} 天 ` : ''}${Math.floor(seconds % 86400 / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`
}

export default function Overview({ onNavigate }: { onNavigate: (page: Destination) => void }) {
  const [minutes, setMinutes] = useState(5)
  const { data, loading, error, refresh } = useResource(() => getDashboardOverview(minutes), [minutes])
  const history: Sample[] = []
  for (const point of data?.history ?? []) {
    const time = point.time * 1000
    const previous = history[history.length - 1]
    const interval = (data?.history_interval_seconds ?? 5) * 1000
    if (previous && time - previous.time > interval * 2 + 10_000) {
      history.push({ time: previous.time + interval, cpu: null, memory: null })
    }
    history.push({ ...point, time })
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !loading) refresh()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [refresh, loading])

  const counts = (status: ServerStatus) => data?.servers.filter((server) => server.status === status).length ?? 0
  const working = data?.servers.filter((server) => ACTIVE_STATES.includes(server.status)).length ?? 0
  const restarts = data?.servers.filter((server) => server.needs_restart).length ?? 0
  const attention = data?.servers.filter((server) => server.status === 'error' || server.status === 'new_setup' || server.needs_restart) ?? []
  const alerts: string[] = []
  if (data && data.cpu_percent >= 90) alerts.push('CPU 高负载')
  if (data && data.memory.percent >= 90) alerts.push('内存占用超过 90%')
  if (data && data.disk.percent >= 90) alerts.push(`磁盘仅剩 ${data.free_disk_gb} GB`)

  const navigate = (page: Destination, label: string) => (
    <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onNavigate(page)}>{label}<ArrowRight className="h-3.5 w-3.5" /></Button>
  )

  return (
    <PageShell title="仪表盘" width="7xl" actions={
      <div className="flex items-center gap-3">
        {data && <span className="hidden text-xs text-muted-foreground sm:block">{formatTime(data.sampled_at)}</span>}
        <Button variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />刷新
        </Button>
      </div>
    }>
      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <span>{data ? '刷新失败，显示上次数据' : '加载失败'} · {error}</span>
        <Button variant="ghost" size="sm" onClick={refresh}>重试</Button>
      </div>}
      {loading && !data ? <div className="flex h-64 items-center justify-center"><InlineLoader /></div> : data ? (
        <div className="space-y-5">
          <PageStatStrip className="grid-cols-2 lg:grid-cols-4">
            <PageStat label="运行中 / 全部实例" value={<>{data.running_servers}<span className="ml-2 text-base font-normal text-muted-foreground">/ {data.total_servers}</span></>} note={`已停止 ${counts('stopped')} · 处理中 ${working}`} />
            <PageStat label="待处理实例" value={attention.length} note={`异常 ${counts('error')} · 待安装 ${counts('new_setup')} · 待重启 ${restarts}`} />
            <PageStat label="自动启动" value={data.servers.filter((server) => server.auto_start).length} />
            <PageStat label="世界存档" value={data.archive_count} note={formatBytes(data.archive_bytes)} />
          </PageStatStrip>

          <PageSurface bodyClassName="grid gap-6 md:grid-cols-3">
            <ResourceMeter icon={Cpu} label="CPU" value={data.cpu_percent} detail={`${data.cpu_threads} 线程`} />
            <ResourceMeter icon={MemoryStick} label="内存" value={data.memory.percent} detail={`${data.memory.used_gb} / ${data.memory.total_gb} GB · 可用 ${data.available_memory_gb} GB`} />
            <ResourceMeter icon={HardDrive} label="数据所在磁盘" value={data.disk.percent} detail={`${data.disk.used_gb} / ${data.disk.total_gb} GB · 剩余 ${data.free_disk_gb} GB`} />
          </PageSurface>

          <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
            <PageSurface title="资源趋势" className="min-w-0" actions={
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="历史时间范围">{[[5, '5 分钟'], [60, '1 小时'], [1440, '24 小时']].map(([value, label]) => <Button key={value} variant={minutes === value ? 'secondary' : 'ghost'} size="sm" aria-pressed={minutes === value} onClick={() => setMinutes(Number(value))}>{label}</Button>)}</div>
            }>
              <div className="mb-3 flex gap-4 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" />CPU</span><span className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-muted-foreground" />内存</span></div>
              <div className="h-56 w-full" role="img" aria-label={`CPU 与内存历史趋势，${data.history?.length ?? 0} 个数据点。当前 CPU ${data.cpu_percent}%，内存 ${data.memory.percent}%。`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history} margin={{ top: 10, right: 12, bottom: 0, left: -20 }} accessibilityLayer>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={formatTime} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} minTickGap={45} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                    <Tooltip labelFormatter={(value) => formatTime(Number(value))} formatter={(value: number) => `${value.toFixed(1)}%`} contentStyle={{ background: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: 8, fontSize: 12, color: 'hsl(var(--popover-foreground))' }} />
                    <Line name="CPU" type="linear" dataKey="cpu" stroke="hsl(var(--primary))" strokeWidth={2} dot={history.length < 2 ? { r: 3 } : false} isAnimationActive={false} />
                    <Line name="内存" type="linear" dataKey="memory" stroke="hsl(var(--muted-foreground))" strokeDasharray="5 3" strokeWidth={2} dot={history.length < 2 ? { r: 3 } : false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {!history.length && <p className="mt-2 text-xs text-muted-foreground">暂无历史数据</p>}
            </PageSurface>

            <PageSurface title="运行检查" actions={<Activity className="h-4 w-4 text-muted-foreground" />} bodyClassName="space-y-5">
              <div className="flex items-start gap-3">
                {attention.length || alerts.length ? <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" /> : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
                <p className="text-sm font-medium">{attention.length || alerts.length ? '需要关注' : '暂无告警'}</p>
              </div>
              {alerts.map((alert) => <p key={alert} className="text-sm text-amber-700 dark:text-amber-300">{alert}</p>)}
              {attention.length > 0 && <ul className="space-y-2 text-sm">{attention.slice(0, 3).map((server) => <li key={server.id} className="flex justify-between gap-3"><span className="truncate" title={server.name}>{server.name}</span><span className="shrink-0 text-muted-foreground">{server.needs_restart ? '待重启' : SERVER_STATUS_META[server.status].label}</span></li>)}{attention.length > 3 && <li className="text-xs text-muted-foreground">另有 {attention.length - 3} 个实例需要关注</li>}</ul>}
              <dl className="space-y-2 border-t pt-4 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">宿主机运行时长</dt><dd className="text-right tabular-nums">{uptime(data.host_uptime_seconds)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">受保护实例</dt><dd>{data.servers.filter((server) => server.protected).length} 个</dd></div>
              </dl>
              {navigate('servers', '管理服务器实例')}
            </PageSurface>
          </div>

          <PageSurface title="服务器实例" bodyClassName="p-0" actions={navigate('servers', '查看全部')}>
            {data.servers.length === 0 ? <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground"><Server className="h-7 w-7 opacity-50" /><p>还没有服务器实例</p>{navigate('servers', '前往创建实例')}</div> : <div className="ops-table-shell border-0"><Table>
              <TableHeader><TableRow><TableHead>实例</TableHead><TableHead>类型 / 版本</TableHead><TableHead>端口</TableHead><TableHead>内存上限</TableHead><TableHead>自动启动</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
              <TableBody>{data.servers.map((server) => <TableRow key={server.id}>
                <TableCell><span className="block max-w-48 truncate font-medium" title={server.name}>{server.name}</span><span className="text-xs text-muted-foreground">{server.group_name || '未分组'}{server.protected ? ' · 受保护' : ''}</span></TableCell>
                <TableCell><span className="block capitalize">{server.server_type}</span><span className="text-xs text-muted-foreground">{server.mc_version || '—'}</span></TableCell>
                <TableCell className="font-mono text-xs">{server.port}</TableCell>
                <TableCell className="font-mono text-xs">{server.max_memory}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{server.auto_start ? '已启用' : '未启用'}</TableCell>
                <TableCell><div className="flex flex-wrap gap-1.5"><Badge variant="outline" className={cn('whitespace-nowrap text-[11px]', SERVER_STATUS_META[server.status].tone)}>{SERVER_STATUS_META[server.status].label}{server.status === 'installing' && server.install ? ` ${server.install.percent.toFixed(0)}%` : ''}</Badge>{server.needs_restart && <Badge variant="outline" className="whitespace-nowrap text-[11px]">待重启</Badge>}</div></TableCell>
              </TableRow>)}</TableBody>
            </Table></div>}
          </PageSurface>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
            <PageSurface title="最近存档" actions={navigate('archives', '管理存档')}>
              {data.recent_archives.length ? <ul className="divide-y">{data.recent_archives.map((archive) => <li key={archive.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <Archive className="h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium" title={archive.name}>{archive.name}</p><p className="mt-1 text-xs text-muted-foreground">{archive.source === 'uploaded' ? '上传存档' : '实例存档'} · {asDate(archive.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</p></div><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(archive.size)}</span>
              </li>)}</ul> : <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground"><Archive className="h-7 w-7 opacity-50" /><p>暂无世界存档</p></div>}
            </PageSurface>
            <PageSurface title="实例状态分布" bodyClassName="space-y-4">
              {data.total_servers ? STATUS_ORDER.filter((status) => counts(status) > 0).map((status) => <div key={status} className="space-y-1.5"><div className="flex justify-between text-xs"><span className="text-muted-foreground">{SERVER_STATUS_META[status].label}</span><span className="tabular-nums">{counts(status)} <span className="text-muted-foreground">/ {data.total_servers}</span></span></div><Progress value={counts(status) / data.total_servers * 100} className="h-1.5" indicatorClassName={status === 'error' ? 'bg-destructive' : status === 'running' ? 'bg-primary' : 'bg-muted-foreground/50'} /></div>) : <p className="py-4 text-sm text-muted-foreground">暂无实例数据</p>}
            </PageSurface>
          </div>
        </div>
      ) : null}
    </PageShell>
  )
}

function ResourceMeter({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: number; detail: string }) {
  return <div className="min-w-0 space-y-2.5">
    <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="h-4 w-4" />{label}</span><span className={cn('text-xl font-semibold tabular-nums', value >= 90 && 'text-destructive')}>{value.toFixed(1)}<span className="ml-0.5 text-sm font-normal text-muted-foreground">%</span></span></div>
    <Progress value={value} className="h-1.5" indicatorClassName={value >= 90 ? 'bg-destructive' : 'bg-primary'} />
    <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
  </div>
}
