import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Loader2, Play, Square, Zap } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type ServerSummary, forceStopServer, startServer, stopServer } from '@/api/servers'
import { useAuth } from '@/components/auth-context'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/dialog-context'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { cn } from '@/lib/utils'

// Share pending/stop-request state across the list, console and other pages.
type Phase = 'idle' | 'busy' | 'stopping'
const phases = new Map<number, Phase>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function setPhase(id: number, phase: Phase) {
  if (phase === 'idle') phases.delete(id)
  else phases.set(id, phase)
  listeners.forEach((listener) => listener())
}

export function ServerLifecycleButton({ server, onChanged }: { server: ServerSummary; onChanged: () => void }) {
  const { canOperate, roleAtLeast } = useAuth()
  const canStop = server.protected ? roleAtLeast('admin') : canOperate
  const confirm = useConfirm()
  const { showToast } = useGlobalToast()
  const phase = useSyncExternalStore(subscribe, () => phases.get(server.id) ?? 'idle')
  const active = server.status === 'running' || server.status === 'starting'
  const current = useRef({ server, canOperate, canStop })
  useEffect(() => { current.current = { server, canOperate, canStop } }, [server, canOperate, canStop])
  useEffect(() => {
    if (phase === 'stopping' && (server.status === 'stopped' || server.status === 'error')) setPhase(server.id, 'idle')
  }, [server.id, server.status, phase])

  const run = async () => {
    const id = server.id
    if (phases.get(id) === 'busy') return
    const force = active && phase === 'stopping'
    const allowed = () => current.current.server.id === id && (active
      ? current.current.canStop && ['running', 'starting'].includes(current.current.server.status)
      : current.current.canOperate && ['stopped', 'queued'].includes(current.current.server.status))
    if (!allowed()) return
    setPhase(id, 'busy')
    let next: Phase = force ? 'stopping' : 'idle'
    try {
      if (force && (!await confirm({ title: `强制停止「${server.name}」?`, description: '将直接杀死进程，未保存的世界改动可能丢失。', confirmText: '强制停止', destructive: true }) || !allowed())) return
      if (!active) await startServer(id)
      else if (force) await forceStopServer(id)
      else { await stopServer(id); next = 'stopping' }
      showToast('success', !active ? '已发送启动命令' : force ? '已强制停止' : '已发送停止命令')
      onChanged()
    } catch (err) { showToast('error', err instanceof ApiError ? err.message : '操作失败') }
    finally { setPhase(id, next) }
  }

  return <Button type="button" size="sm" variant={active && phase === 'stopping' ? 'destructive' : 'outline'}
    className={cn('gap-1.5', !active && 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 hover:text-white')}
    disabled={phase === 'busy' || (active ? !canStop : !canOperate || !['stopped', 'queued'].includes(server.status))} onClick={run}>
    {phase === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : active ? phase === 'stopping' ? <Zap className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
    {active ? phase === 'stopping' ? '强制停止' : '停止' : '启动'}
  </Button>
}
