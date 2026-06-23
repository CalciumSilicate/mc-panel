import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Crown, Loader2, Send, Shield } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type ChatMember,
  type ChatMessage,
  type ChatSegment,
  chatWsUrl,
  getChatMembers,
  sendChat,
} from '@/api/chat'
import { listGroups } from '@/api/groups'
import { useAuth } from '@/components/auth-context'
import { PageShell } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const mcAvatar = (name: string) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`
const qqAvatar = (uid: string) => `https://q1.qlogo.cn/g?b=qq&nk=${uid}&s=100`

function Avatar({ src, name, className }: { src?: string; name: string; className?: string }) {
  const [ok, setOk] = useState(true)
  if (src && ok) {
    return <img src={src} alt={name} className={cn('rounded-full object-cover', className)} onError={() => setOk(false)} />
  }
  return (
    <div className={cn('flex items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary', className)}>
      {(name || '?').slice(0, 1).toUpperCase()}
    </div>
  )
}

function Segments({
  segs,
  fallback,
  mine,
  onAt,
}: {
  segs?: ChatSegment[]
  fallback: string
  mine: boolean
  onAt: (name: string, qq?: string) => void
}) {
  const list = segs && segs.length > 0 ? segs : [{ type: 'text' as const, text: fallback }]
  return (
    <>
      {list.map((s, i) => {
        if (s.type === 'image')
          return (
            <a key={i} href={s.url} target="_blank" rel="noreferrer">
              <img src={s.url} alt="图片" className="my-0.5 max-h-52 max-w-full rounded-lg" loading="lazy" />
            </a>
          )
        if (s.type === 'at') {
          const label = s.name || s.qq || ''
          return (
            <button
              key={i}
              type="button"
              onClick={() => onAt(label, s.qq)}
              className={cn(
                'font-medium underline-offset-2 hover:underline',
                mine ? 'text-primary-foreground' : 'text-sky-600 dark:text-sky-400',
              )}
            >
              @{label}
            </button>
          )
        }
        if (s.type === 'face') return <span key={i} className="opacity-70">[表情]</span>
        if (s.type === 'reply')
          return (
            <span key={i} className={cn('mb-1 block border-l-2 pl-2 text-xs opacity-70', mine ? 'border-primary-foreground/40' : 'border-muted-foreground/40')}>
              回复 {s.user}：{s.text}
            </span>
          )
        return <span key={i} className="whitespace-pre-wrap break-words">{s.text}</span>
      })}
    </>
  )
}

const SOURCE_BADGE: Record<ChatMessage['source'], { label: string; tone: string }> = {
  mc: { label: 'MC', tone: 'text-emerald-600 dark:text-emerald-400' },
  qq: { label: 'QQ', tone: 'text-amber-600 dark:text-amber-400' },
  web: { label: '网页', tone: 'text-primary' },
  system: { label: '系统', tone: 'text-muted-foreground' },
}

function MessageRow({ msg, mine, onAt }: { msg: ChatMessage; mine: boolean; onAt: (name: string, qq?: string) => void }) {
  if (msg.source === 'system') {
    return (
      <div className="my-1 text-center">
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {msg.server ? `[${msg.server}] ` : ''}{msg.text}
        </span>
      </div>
    )
  }
  const name = msg.sender || '?'
  const badge = SOURCE_BADGE[msg.source]
  return (
    <div className={cn('flex gap-2', mine && 'flex-row-reverse')}>
      <Avatar src={msg.avatar} name={name} className="h-9 w-9 shrink-0" />
      <div className={cn('flex min-w-0 max-w-[78%] flex-col items-start', mine && 'items-end')}>
        <div className="mb-0.5 flex items-center gap-1.5 text-xs">
          <span className={cn('font-medium', badge.tone)}>{badge.label}</span>
          <span className="text-muted-foreground">{name}{msg.server ? `·${msg.server}` : ''}</span>
        </div>
        <div
          className={cn(
            'rounded-2xl px-3 py-2 text-sm leading-relaxed',
            mine ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'rounded-tl-sm bg-muted',
          )}
        >
          <Segments segs={msg.segments} fallback={msg.text} mine={mine} onAt={onAt} />
        </div>
      </div>
    </div>
  )
}

function RoleIcon({ role }: { role?: string }) {
  if (role === 'owner') return <Crown className="h-3.5 w-3.5 text-amber-500" />
  if (role === 'admin') return <Shield className="h-3.5 w-3.5 text-sky-500" />
  return null
}

export default function Chat() {
  const { user, canOperate } = useAuth()
  const { showToast } = useGlobalToast()
  const { data: groups } = useResource(() => listGroups(), [])
  const [groupId, setGroupId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [members, setMembers] = useState<{ players: ChatMember[]; qq: ChatMember[] }>({ players: [], qq: [] })
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [atOpen, setAtOpen] = useState(false)
  const [atIndex, setAtIndex] = useState(0)
  const [mentions, setMentions] = useState<Record<string, string>>({}) // 名字 -> QQ号(真实 @)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (groupId === null && groups && groups.length > 0) setGroupId(groups[0].id)
  }, [groups, groupId])

  useEffect(() => {
    if (groupId === null) return
    setMessages([])
    const ws = new WebSocket(chatWsUrl(groupId))
    ws.onmessage = (e) => {
      try {
        setMessages((cur) => [...cur.slice(-300), JSON.parse(e.data) as ChatMessage])
      } catch {
        // ignore
      }
    }
    return () => ws.close()
  }, [groupId])

  // 成员列表(玩家 + QQ),每 15s 刷新
  useEffect(() => {
    if (groupId === null) return
    let alive = true
    const load = () => getChatMembers(groupId).then((m) => alive && setMembers(m)).catch(() => undefined)
    load()
    const t = window.setInterval(load, 15000)
    return () => { alive = false; window.clearInterval(t) }
  }, [groupId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const atQuery = useMemo(() => {
    const m = text.match(/@([^\s@]*)$/)
    return m ? m[1] : null
  }, [text])

  const atCandidates = useMemo(() => {
    if (atQuery === null) return []
    const q = atQuery.toLowerCase()
    const all: ChatMember[] = [...members.players, ...members.qq]
    return all.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 8)
  }, [atQuery, members])

  useEffect(() => {
    setAtOpen(atQuery !== null && atCandidates.length > 0)
    setAtIndex(0)
  }, [atQuery, atCandidates])

  const pickAt = (m: ChatMember) => {
    setText((cur) => cur.replace(/@([^\s@]*)$/, `@${m.name} `))
    if (m.user_id) setMentions((cur) => ({ ...cur, [m.name]: m.user_id! }))
    setAtOpen(false)
    inputRef.current?.focus()
  }

  const send = async () => {
    const t = text.trim()
    if (!t || groupId === null) return
    // 把 @名字 转成真实 CQ at(仅 QQ 成员);游戏玩家保持 @名字 文本
    let payload = t
    for (const [name, qq] of Object.entries(mentions)) {
      payload = payload.split(`@${name}`).join(`[CQ:at,qq=${qq}]`)
    }
    setSending(true)
    try {
      await sendChat(groupId, payload)
      setText('')
      setMentions({})
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  // 点击消息里的 @,把 @该人 填进输入框(QQ 成员带真实 ping)
  const insertAt = (name: string, qq?: string) => {
    setText((cur) => cur + (cur && !cur.endsWith(' ') ? ' ' : '') + `@${name} `)
    if (qq) setMentions((cur) => ({ ...cur, [name]: qq }))
    inputRef.current?.focus()
  }

  const onInputKeyDown = (e: ReactKeyboardEvent) => {
    if (atOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAtIndex((i) => Math.min(i + 1, atCandidates.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAtIndex((i) => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter') { e.preventDefault(); pickAt(atCandidates[atIndex]); return }
      if (e.key === 'Escape') { e.preventDefault(); setAtOpen(false); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const hasGroups = (groups?.length ?? 0) > 0

  return (
    <PageShell
      title="聊天室"
      description="按互联组的气泡聊天:MC / QQ / 网页 三向互通。"
      width="6xl"
      actions={
        hasGroups ? (
          <Select value={groupId === null ? undefined : String(groupId)} onValueChange={(v) => setGroupId(Number(v))}>
            <SelectTrigger className="w-48"><SelectValue placeholder="选择互联组" /></SelectTrigger>
            <SelectContent>
              {(groups ?? []).map((g) => (<SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>))}
            </SelectContent>
          </Select>
        ) : null
      }
    >
      {!hasGroups ? (
        <div className="ops-surface py-12 text-center text-sm text-muted-foreground">
          还没有互联组,先在「服务器实例 → 互联组」里创建。
        </div>
      ) : (
        <div className="flex h-[68vh] gap-4">
          {/* 聊天区 */}
          <div className="ops-surface flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className="scrollbar-none flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">暂无消息。</p>
              ) : (
                messages.map((m, i) => (
                  <MessageRow key={i} msg={m} mine={m.source === 'web' && m.sender === user.username} onAt={insertAt} />
                ))
              )}
            </div>
            <div className="relative border-t border-border/70 px-4 py-3">
              {atOpen ? (
                <div className="absolute bottom-full left-4 mb-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-border/70 bg-popover shadow-lg">
                  {atCandidates.map((m, i) => (
                    <button
                      key={i}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                        i === atIndex ? 'bg-muted' : 'hover:bg-muted',
                      )}
                      onMouseEnter={() => setAtIndex(i)}
                      onMouseDown={(e) => { e.preventDefault(); pickAt(m) }}
                    >
                      <Avatar src={m.user_id ? qqAvatar(m.user_id) : mcAvatar(m.name)} name={m.name} className="h-5 w-5" />
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="text-xs text-muted-foreground">{m.user_id ? 'QQ' : m.server}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Input
                  ref={inputRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder={canOperate ? '说点什么…(@ 可提及成员,发到游戏与 QQ)' : '账号未验证,只读'}
                  disabled={!canOperate || sending}
                />
                <Button type="button" className="gap-1.5 shrink-0" onClick={send} disabled={!canOperate || sending || !text.trim()}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  发送
                </Button>
              </div>
            </div>
          </div>

          {/* 成员栏 */}
          <div className="hidden w-56 shrink-0 flex-col gap-4 lg:flex">
            <div className="ops-surface flex min-h-0 flex-1 flex-col">
              <div className="border-b border-border/70 px-3 py-2 text-xs font-medium text-muted-foreground">
                游戏在线 · {members.players.length}
              </div>
              <div className="scrollbar-none flex-1 overflow-y-auto p-2">
                {members.players.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">无</p>
                ) : (
                  members.players.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
                      <Avatar src={mcAvatar(p.name)} name={p.name} className="h-6 w-6" />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="text-[11px] text-muted-foreground">{p.server}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="ops-surface flex min-h-0 flex-1 flex-col">
              <div className="border-b border-border/70 px-3 py-2 text-xs font-medium text-muted-foreground">
                QQ 群成员 · {members.qq.length}
              </div>
              <div className="scrollbar-none flex-1 overflow-y-auto p-2">
                {members.qq.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">无 / 未连接</p>
                ) : (
                  members.qq.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
                      <Avatar src={m.user_id ? qqAvatar(m.user_id) : undefined} name={m.name} className="h-6 w-6" />
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <RoleIcon role={m.role} />
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  )
}
