import { KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Loader2, Play, SendHorizonal, Square, Terminal } from 'lucide-react'

import { getAuthToken } from '@/api/client'
import { ApiError } from '@/api/client'
import { type ServerSummary, startServer, stopServer } from '@/api/servers'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { parseAnsi } from '@/lib/ansi'
import { cn } from '@/lib/utils'

/**
 * 实例控制台 —— 通过 WebSocket 实时接收日志、向实例 stdin 发送命令,
 * 并可直接启停实例。token 用 query 参数传递(浏览器 WebSocket 无法自定义请求头)。
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
  /** 启停后通知父组件刷新列表(从而更新本对话框的 server.status)。 */
  onChanged: () => void
}

export function ServerConsoleDialog({ server, onClose, onChanged }: ServerConsoleDialogProps) {
  const { showToast } = useGlobalToast()
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [input, setInput] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const serverId = server?.id ?? null
  const status = server?.status

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

  const canSend = connected && status === 'running'

  const sendCommand = () => {
    const command = input.trim()
    const ws = wsRef.current
    if (!command || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ command }))
    setLines((prev) => [...prev, ...command.split('\n').map((l) => `> ${l}`)])
    setInput('')
  }

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送;Shift+Enter 换行(默认行为)
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendCommand()
    }
  }

  const runLifecycle = async (action: 'start' | 'stop') => {
    if (serverId === null) return
    setActionBusy(true)
    try {
      if (action === 'start') {
        await startServer(serverId)
        showToast('success', '已启动')
      } else {
        await stopServer(serverId)
        showToast('success', '已发送停止命令')
      }
      onChanged()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setActionBusy(false)
    }
  }

  const installing = status === 'installing' || status === 'new_setup'

  return (
    <Dialog open={server !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="flex h-[85vh] max-h-[900px] w-[94vw] max-w-6xl flex-col gap-3">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-3 pr-10">
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

            <div className="flex items-center gap-2">
              {status === 'running' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={actionBusy}
                  onClick={() => runLifecycle('stop')}
                >
                  {actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                  停止
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={actionBusy || installing || status !== 'stopped'}
                  onClick={() => runLifecycle('start')}
                >
                  {actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  启动
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div
          ref={logRef}
          className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/70 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100"
        >
          {lines.length === 0 ? (
            <p className="text-zinc-500">等待日志输出…</p>
          ) : (
            lines.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-all">
                {parseAnsi(line).map((seg, i) => (
                  <span
                    key={i}
                    style={{
                      color: seg.color,
                      fontWeight: seg.bold ? 700 : undefined,
                      opacity: seg.dim ? 0.65 : undefined,
                    }}
                  >
                    {seg.text}
                  </span>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onTextareaKeyDown}
            rows={1}
            placeholder={canSend ? '输入命令,Enter 发送,Shift+Enter 换行' : '实例未运行,无法发送命令'}
            disabled={!canSend}
            className="max-h-40 min-h-11 flex-1 resize-y py-2.5 font-mono leading-5"
          />
          <Button type="button" className="h-11 gap-1.5" onClick={sendCommand} disabled={!canSend || !input.trim()}>
            <SendHorizonal className="h-4 w-4" />
            发送
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
