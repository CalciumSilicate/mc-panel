import { useEffect } from 'react'
import { Cpu, HardDrive, MemoryStick, RefreshCw, Server } from 'lucide-react'

import { getDashboardOverview } from '@/api/system'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SERVER_STATUS_META } from '@/lib/server-status'
import { motion, staggerContainer } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useResource } from '@/lib/use-resource'

/**
 * 仪表盘 —— 宿主机资源占用 + 服务器实例概览。
 * 数据走 useResource;每 5s 自动刷新一次,顶部也提供手动刷新。
 */
export default function Overview() {
  const { data, loading, error, refresh } = useResource(() => getDashboardOverview(), [])

  useEffect(() => {
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  return (
    <PageShell
      title="仪表盘"
      description="宿主机资源与服务器实例的实时概览。"
      width="7xl"
      actions={
        <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          刷新
        </Button>
      }
    >
      {error ? (
        <PageSurface>
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              重试
            </Button>
          </div>
        </PageSurface>
      ) : loading && !data ? (
        <div className="flex h-64 items-center justify-center">
          <InlineLoader />
        </div>
      ) : data ? (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ResourceCard icon={Cpu} label="CPU 占用" value={`${data.cpu_percent.toFixed(1)}%`} percent={data.cpu_percent} />
            <ResourceCard
              icon={MemoryStick}
              label="内存占用"
              value={`${data.memory.used_gb} / ${data.memory.total_gb} GB`}
              percent={data.memory.percent}
            />
            <ResourceCard
              icon={HardDrive}
              label="磁盘占用"
              value={`${data.disk.used_gb} / ${data.disk.total_gb} GB`}
              percent={data.disk.percent}
            />
            <PageSurface>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Server className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">服务器</p>
                  <p className="truncate text-sm font-medium text-foreground">
                    {data.running_servers} / {data.total_servers} 运行中
                  </p>
                </div>
              </div>
            </PageSurface>
          </div>

          <PageSurface title="服务器实例" bodyClassName="p-0">
            {data.servers.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
                <Server className="h-8 w-8 opacity-40" />
                还没有服务器实例,去「服务器实例」页新建一个。
              </div>
            ) : (
              <div className="ops-table-shell border-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead>版本</TableHead>
                      <TableHead>端口</TableHead>
                      <TableHead>状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.servers.map((server) => {
                      const meta = SERVER_STATUS_META[server.status]
                      return (
                        <TableRow key={server.id}>
                          <TableCell className="font-medium">{server.name}</TableCell>
                          <TableCell className="text-muted-foreground">{server.mc_version || '—'}</TableCell>
                          <TableCell className="font-mono text-muted-foreground">{server.port}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn('text-[11px]', meta.tone)}>
                              {meta.label}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </PageSurface>
        </motion.div>
      ) : null}
    </PageShell>
  )
}

// 占用率配色(参考 AMP-Manager 排行榜:灰/绿/蓝/黄/橙/红,按压力递增)
function usageClasses(p: number): { text: string; bar: string } {
  if (p <= 0) return { text: 'text-muted-foreground', bar: 'bg-muted-foreground/60' }
  if (p < 10) return { text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500' }
  if (p < 50) return { text: 'text-blue-600 dark:text-blue-400', bar: 'bg-blue-500' }
  if (p < 75) return { text: 'text-yellow-600 dark:text-yellow-400', bar: 'bg-yellow-500' }
  if (p < 90) return { text: 'text-orange-600 dark:text-orange-400', bar: 'bg-orange-500' }
  return { text: 'text-red-600 dark:text-red-400', bar: 'bg-red-500' }
}

function ResourceCard({
  icon: Icon,
  label,
  value,
  percent,
}: {
  icon: typeof Cpu
  label: string
  value: string
  percent: number
}) {
  const c = usageClasses(percent)
  return (
    <PageSurface>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="truncate font-mono text-sm font-medium text-foreground">{value}</p>
        </div>
        <span className={cn('ml-auto text-lg font-semibold tabular-nums', c.text)}>{percent.toFixed(0)}%</span>
      </div>
      <Progress value={percent} className="mt-3 h-1.5" indicatorClassName={c.bar} />
    </PageSurface>
  )
}
