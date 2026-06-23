import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Send } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type ChatMessage, chatWsUrl, sendChat } from '@/api/chat'
import { listGroups } from '@/api/groups'
import { useAuth } from '@/components/auth-context'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const SOURCE_LABEL: Record<ChatMessage['source'], string> = {
  mc: 'MC',
  qq: 'QQ',
  web: '网页',
  system: '系统',
}
const SOURCE_TONE: Record<ChatMessage['source'], string> = {
  mc: 'text-emerald-600 dark:text-emerald-400',
  qq: 'text-amber-600 dark:text-amber-400',
  web: 'text-primary',
  system: 'text-muted-foreground',
}

export default function Chat() {
  const { canOperate } = useAuth()
  const { showToast } = useGlobalToast()
  const { data: groups } = useResource(() => listGroups(), [])
  const [groupId, setGroupId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (groupId === null && groups && groups.length > 0) setGroupId(groups[0].id)
  }, [groups, groupId])

  // 连接当前互联组的聊天流
  useEffect(() => {
    if (groupId === null) return
    setMessages([])
    const ws = new WebSocket(chatWsUrl(groupId))
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as ChatMessage
        setMessages((cur) => [...cur.slice(-300), msg])
      } catch {
        // ignore
      }
    }
    return () => ws.close()
  }, [groupId])

  // 自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = async () => {
    const t = text.trim()
    if (!t || groupId === null) return
    setSending(true)
    try {
      await sendChat(groupId, t)
      setText('')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const hasGroups = useMemo(() => (groups?.length ?? 0) > 0, [groups])

  return (
    <PageShell
      title="聊天室"
      description="按互联组查看 MC / QQ / 网页 的互通消息,并从网页发送。"
      width="5xl"
      actions={
        hasGroups ? (
          <Select value={groupId === null ? undefined : String(groupId)} onValueChange={(v) => setGroupId(Number(v))}>
            <SelectTrigger className="w-48"><SelectValue placeholder="选择互联组" /></SelectTrigger>
            <SelectContent>
              {(groups ?? []).map((g) => (
                <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null
      }
    >
      <PageSurface bodyClassName="p-0">
        {!hasGroups ? (
          <p className="py-12 text-center text-sm text-muted-foreground">还没有互联组,先在「服务器实例 → 互联组」里创建。</p>
        ) : (
          <div className="flex h-[60vh] flex-col">
            <div ref={scrollRef} className="scrollbar-none flex-1 space-y-1.5 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">暂无消息。</p>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className="text-sm leading-relaxed">
                    <span className={cn('mr-1.5 shrink-0 text-xs font-medium', SOURCE_TONE[m.source])}>
                      [{SOURCE_LABEL[m.source]}{m.server ? `·${m.server}` : ''}]
                    </span>
                    {m.source === 'system' ? (
                      <span className="text-muted-foreground">{m.text}</span>
                    ) : (
                      <>
                        <span className="font-medium">{m.player || m.user}</span>
                        <span className="text-muted-foreground">:</span>{' '}
                        <span className="break-words">{m.text}</span>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-border/70 px-4 py-3">
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder={canOperate ? '说点什么…(发到游戏与 QQ)' : '账号未验证,只读'}
                disabled={!canOperate || sending}
              />
              <Button type="button" className="gap-1.5 shrink-0" onClick={send} disabled={!canOperate || sending || !text.trim()}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                发送
              </Button>
            </div>
          </div>
        )}
      </PageSurface>
    </PageShell>
  )
}
