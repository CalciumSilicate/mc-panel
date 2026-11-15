import { useEffect, useState } from 'react'
import { ChevronDown, Loader2, MoreHorizontal, Play, Power, RefreshCw, Server, Square } from 'lucide-react'
import { apiRequest } from '@/api/client'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/dialog-context'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

type Status = { status: string; message?: string; processes: { id: number; pid: number }[]; queued: number[] }
export function RuntimeControls() {
  const { data, error, refreshing, refresh } = useResource(() => apiRequest<Status>('/settings/runtime'), [])
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const confirm = useConfirm()
  useEffect(() => { const timer = window.setInterval(refresh, 3000); return () => clearInterval(timer) }, [refresh])
  const operate = async (action: 'start' | 'stop', stopInstances = false) => {
    if (busy) return
    if (action === 'stop' && !await confirm({ title: '停止 MCDR 托管服务？', description: stopInstances ? '将停止所有实例后退出托管服务，网站继续运行。停服超时的实例可能被强制结束。' : '退出托管服务，网站继续运行；有运行中的实例时会拒绝停止。', confirmText: '停止托管', destructive: true })) return
    setBusy(true); setFailure('')
    try { await apiRequest(`/settings/runtime/${action}?stop_instances=${stopInstances}`, { method: 'POST' }); refresh() }
    catch (error) { setFailure(error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false) }
  }
  const status = error ? 'unavailable' : data?.status
  const running = status === 'running'
  const canStart = status === 'stopped' || status === 'unavailable'
  const problem = failure || error || (status === 'unavailable' ? data?.message : '')
  return <section aria-label="MCDR 托管服务" className="border-b border-border/60 pb-5">
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 py-1">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"><Server className="h-5 w-5" /></div>
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold">MCDR 托管服务</h2>
            <span role="status" className={cn('inline-flex items-center gap-1.5 text-xs', running ? 'text-emerald-700 dark:text-emerald-400' : status === 'unavailable' ? 'text-destructive' : 'text-muted-foreground')}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {({ running: '运行中', stopping: '正在停止', stopped: '已停止', unavailable: '连接异常' })[status ?? ''] ?? '读取状态…'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">网站重启不影响服务器运行</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {data && <span className="mr-2 text-xs tabular-nums text-muted-foreground"><span className="font-medium text-foreground">{data.processes.length}</span> 个实例{data.queued.length > 0 && <> · {data.queued.length} 个排队</>}</span>}
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label="刷新托管状态" title="刷新状态" disabled={refreshing || busy} onClick={refresh}><RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'motion-safe:animate-spin')} /></Button>
        {canStart && <Button type="button" size="sm" disabled={busy} onClick={() => operate('start')}>{busy ? <Loader2 className="motion-safe:animate-spin" /> : <Play />}启动托管</Button>}
        {running && <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="outline" size="sm" disabled={busy} aria-label="托管服务操作">{busy ? <Loader2 className="motion-safe:animate-spin" /> : <MoreHorizontal />}管理</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => operate('stop')}><Square />停止托管</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => operate('stop', true)}><Power />停服并退出托管</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
    </div>
    {problem && <p role="alert" className="mt-3 text-xs text-destructive">{problem}</p>}
    {!!data?.processes.length && <div className="mt-3">
      <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm" aria-expanded={expanded} aria-controls="runtime-processes" onClick={() => setExpanded(!expanded)}>
        实例详情<ChevronDown className={cn('h-3.5 w-3.5 transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
      </button>
      {expanded && <div id="runtime-processes" className="mt-3 divide-y divide-border/50 border-t border-border/50 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
        {data.processes.map(process => <div key={process.id} className="flex items-center justify-between py-2 text-xs"><span>实例 #{process.id}</span><span className="font-mono tabular-nums text-muted-foreground">PID {process.pid}</span></div>)}
      </div>}
    </div>}
  </section>
}
