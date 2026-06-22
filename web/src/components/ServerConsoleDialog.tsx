import { FormEvent, useEffect, useRef, useState } from 'react'
import { SendHorizonal, Terminal } from 'lucide-react'

import { getAuthToken } from '@/api/client'
import type { ServerSummary } from '@/api/servers'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * 实例控制台 —— 通过 WebSocket 实时接收日志、向实例 stdin 发送命令。
 * 连接地址与当前页面同源(经 vite/后端代理),token 用 query 参数传递,
 * 因为浏览器 WebSocket 无法自定义请求头。
 */

const MAX_LINES = 2000

function consoleWsUrl(serverId: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const token = getAuthToken()
  return `${proto}://${window.location.host}/api/servers/${serverId}/console?token=${encodeURIComponent(token)}`
}

interface ServerConsoleDialogProps {
  server: ServerSummary | null
  onClose: () => void
}

export function ServerConsoleDialog({ server, onClose }: ServerConsoleDialogProps) {
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [input, setInput] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const serverId = server?.id ?? null

  useEffect(() => {
    if (serverId === null) return
    setLines([])
    setConnected(false)

    const ws = new WebSocket(consoleWsUrl(serverId))
    wsRef.current = ws

    const append = (line: string) =>
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice()
        next.push(line)
        return next
      })

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => append('[mc-panel] 连接出错')
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'log') append(msg.line)
        else if (msg.type === 'error') append(`[错误] ${msg.message}`)
      } catch {
        /* 忽略非 JSON 帧 */
      }
    }

    return () => {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null
      ws.close()
      wsRef.current = null
    }
  }, [serverId])

  // 新日志到达后滚动到底部
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const sendCommand = (event: FormEvent) => {
    event.preventDefault()
    const command = input.trim()
    const ws = wsRef.current
    if (!command || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ command }))
    setLines((prev) => [...prev, `> ${command}`])
    setInput('')
  }

  const canSend = connected && server?.status === 'running'

  return (
    <Dialog open={server !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            控制台 —— {server?.name}
            <span
              className={cn(
                'ml-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-normal',
                connected
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-border/70 bg-muted text-muted-foreground',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-muted-foreground')} />
              {connected ? '已连接' : '未连接'}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div
          ref={logRef}
          className="h-[55vh] overflow-y-auto rounded-md border border-border/70 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100"
        >
          {lines.length === 0 ? (
            <p className="text-zinc-500">等待日志输出…</p>
          ) : (
            lines.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )}
        </div>

        <form onSubmit={sendCommand} className="flex items-center gap-2">
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={canSend ? '输入命令后回车,例如 list' : '实例未运行,无法发送命令'}
            disabled={!canSend}
            className="font-mono"
          />
          <Button type="submit" className="gap-1.5" disabled={!canSend || !input.trim()}>
            <SendHorizonal className="h-4 w-4" />
            发送
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
