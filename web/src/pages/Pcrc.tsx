import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Circle, Download, Loader2, Play, Plus, Square, Trash2, Video } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type PcrcInstance,
  type PcrcReplay,
  createPcrc,
  deletePcrc,
  deleteReplay,
  downloadReplay,
  installPcrc,
  listPcrc,
  pcrcCommand,
  pcrcConsole,
  pcrcReplays,
  startPcrc,
  stopPcrc,
  updatePcrc,
} from '@/api/pcrc'
import { useAuth } from '@/components/auth-context'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useConfirm } from '@/components/ui/dialog-context'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const ANSI_COLORS: Record<number, string> = {
  30: 'text-neutral-500', 31: 'text-red-400', 32: 'text-emerald-400', 33: 'text-amber-400',
  34: 'text-blue-400', 35: 'text-fuchsia-400', 36: 'text-cyan-400', 37: 'text-neutral-300',
  90: 'text-neutral-500', 91: 'text-red-300', 92: 'text-emerald-300', 93: 'text-amber-300',
  94: 'text-blue-300', 95: 'text-fuchsia-300', 96: 'text-cyan-300', 97: 'text-white',
}

function AnsiLine({ text }: { text: string }) {
  // eslint-disable-next-line no-control-regex
  const re = /\[([0-9;]*)m/g
  const parts: ReactNode[] = []
  let last = 0
  let cls = ''
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={key++} className={cls || undefined}>{text.slice(last, m.index)}</span>)
    const codes = m[1].split(';').filter(Boolean).map(Number)
    if (codes.length === 0 || codes.includes(0)) cls = ''
    for (const c of codes) {
      if (ANSI_COLORS[c]) cls = ANSI_COLORS[c]
      else if (c === 1) cls = `${cls} font-semibold`.trim()
    }
    last = re.lastIndex
  }
  if (last < text.length) parts.push(<span key={key++} className={cls || undefined}>{text.slice(last)}</span>)
  return <>{parts}</>
}

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

export default function Pcrc() {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const { roleAtLeast } = useAuth()
  const isAdmin = roleAtLeast('admin')
  const { data, loading, refresh } = useResource(() => listPcrc(), [])
  const [selId, setSelId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [installing, setInstalling] = useState(false)

  const instances = useMemo(() => data?.instances ?? [], [data])
  const available = data?.available ?? false
  const sel = instances.find((i) => i.id === selId) ?? null

  useEffect(() => {
    if (selId === null && instances.length > 0) setSelId(instances[0].id)
  }, [instances, selId])

  const doInstall = async () => {
    setInstalling(true)
    try {
      await installPcrc()
      showToast('success', '已安装 PCRC')
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '安装失败')
    } finally {
      setInstalling(false)
    }
  }

  const onDelete = async (i: PcrcInstance) => {
    if (!(await confirm({ title: `删除录像机「${i.name}」?`, description: '实例目录与录像文件一并删除。', confirmText: '删除', destructive: true }))) return
    try {
      await deletePcrc(i.id)
      if (selId === i.id) setSelId(null)
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '删除失败')
    }
  }

  return (
    <PageShell
      title="PCRC 录像机"
      description="模拟客户端连进服务器录制 .mcpr(ReplayMod 可编辑)。microsoft 登录的设备码会出现在控制台。"
      width="6xl"
      actions={
        isAdmin ? (
          <Button type="button" className="gap-2" onClick={() => setCreating(true)} disabled={!available}>
            <Plus className="h-4 w-4" />新建录像机
          </Button>
        ) : null
      }
    >
      {!available ? (
        <PageSurface>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">尚未安装 PCRC。{isAdmin ? '点下方安装(pip 安装到后端环境)。' : '请联系管理员安装。'}</p>
            {isAdmin ? (
              <Button type="button" className="gap-2" onClick={doInstall} disabled={installing}>
                {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}安装 PCRC
              </Button>
            ) : null}
          </div>
        </PageSurface>
      ) : loading && !data ? (
        <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
      ) : instances.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有录像机,点右上角新建。</p></PageSurface>
      ) : (
        <div className="flex gap-4">
          <div className="w-56 shrink-0 space-y-1.5">
            {instances.map((i) => (
              <button
                key={i.id}
                type="button"
                className={cn('flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm', selId === i.id ? 'border-primary bg-primary/5' : 'border-border/70 hover:bg-muted')}
                onClick={() => setSelId(i.id)}
              >
                <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{i.name}</span>
                {i.running ? <Circle className="h-2.5 w-2.5 shrink-0 fill-emerald-500 text-emerald-500" /> : null}
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            {sel ? <Detail key={sel.id} inst={sel} isAdmin={isAdmin} onChanged={refresh} onDelete={() => onDelete(sel)} /> : null}
          </div>
        </div>
      )}

      {creating ? <CreateDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh() }} /> : null}
    </PageShell>
  )
}

function Detail({ inst, isAdmin, onChanged, onDelete }: { inst: PcrcInstance; isAdmin: boolean; onChanged: () => void; onDelete: () => void }) {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const [form, setForm] = useState({ address: inst.address, port: String(inst.port), authenticate_type: inst.authenticate_type as string, username: inst.username })
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(inst.running)
  const [busy, setBusy] = useState(false)
  const [cmd, setCmd] = useState('')
  const [replays, setReplays] = useState<PcrcReplay[]>([])
  const consoleRef = useRef<HTMLDivElement>(null)

  const loadReplays = () => pcrcReplays(inst.id).then(setReplays).catch(() => undefined)

  useEffect(() => {
    let alive = true
    const tick = () => pcrcConsole(inst.id).then((c) => { if (alive) { setLines(c.lines); setRunning(c.running) } }).catch(() => undefined)
    tick()
    loadReplays()
    const t = window.setInterval(tick, 1500)
    return () => { alive = false; window.clearInterval(t) }
  }, [inst.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = consoleRef.current; if (el) el.scrollTop = el.scrollHeight }, [lines])

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); showToast('success', ok); onChanged() } catch (err) { showToast('error', err instanceof ApiError ? err.message : '操作失败') } finally { setBusy(false) }
  }

  const saveConfig = () => act(() => updatePcrc(inst.id, { address: form.address, port: Number(form.port) || 25565, authenticate_type: form.authenticate_type, username: form.username }), '已保存配置')
  const send = async (text: string) => { try { await pcrcCommand(inst.id, text) } catch (err) { showToast('error', err instanceof ApiError ? err.message : '发送失败') } }

  const onDelReplay = async (r: PcrcReplay) => {
    if (!(await confirm({ title: `删除录像「${r.name}」?`, confirmText: '删除', destructive: true }))) return
    await deleteReplay(inst.id, r.name)
    loadReplays()
  }

  return (
    <div className="space-y-4">
      <PageSurface
        title={inst.name}
        actions={
          <div className="flex gap-2">
            {running ? (
              <Button type="button" variant="outline" className="gap-1.5" disabled={busy} onClick={() => act(() => stopPcrc(inst.id), '已停止')}><Square className="h-4 w-4" />停止</Button>
            ) : (
              <Button type="button" className="gap-1.5" disabled={busy} onClick={() => act(() => startPcrc(inst.id), '已启动')}><Play className="h-4 w-4" />启动</Button>
            )}
            {isAdmin ? <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" title="删除" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button> : null}
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1.5"><Label>服务器地址</Label><Input value={form.address} disabled={!isAdmin || running} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label>端口</Label><Input value={form.port} disabled={!isAdmin || running} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} className="font-mono" /></div>
          <div className="space-y-1.5">
            <Label>登录方式</Label>
            <Select value={form.authenticate_type} onValueChange={(v) => setForm((f) => ({ ...f, authenticate_type: v }))} disabled={!isAdmin || running}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="offline">offline(离线名)</SelectItem>
                <SelectItem value="microsoft">microsoft(设备码)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>{form.authenticate_type === 'offline' ? '玩家名' : '账号邮箱'}</Label><Input value={form.username} disabled={!isAdmin || running} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} /></div>
        </div>
        {isAdmin ? <div className="mt-3 flex justify-end"><Button type="button" variant="outline" disabled={busy || running} onClick={saveConfig}>保存配置</Button></div> : null}
      </PageSurface>

      <PageSurface title="控制台" bodyClassName="p-0">
        <div ref={consoleRef} className="scrollbar-none h-56 overflow-y-auto bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed">
          {lines.length === 0 ? <p className="text-muted-foreground">(无输出)</p> : lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all"><AnsiLine text={l} /></div>)}
        </div>
        <div className="flex items-center gap-2 border-t border-border/70 px-3 py-2">
          <Button type="button" size="sm" variant="outline" disabled={!running} onClick={() => send('start')}>● 开始录制</Button>
          <Button type="button" size="sm" variant="outline" disabled={!running} onClick={() => send('stop')}>■ 停止录制</Button>
          <Input value={cmd} disabled={!running} placeholder="向 PCRC 发送指令…" onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && cmd.trim()) { send(cmd.trim()); setCmd('') } }} className="font-mono" />
        </div>
      </PageSurface>

      <PageSurface title="录像文件" actions={<Button type="button" variant="outline" size="sm" onClick={loadReplays}>刷新</Button>} bodyClassName="p-0">
        {replays.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">还没有录像(停止录制后才会生成 .mcpr)。</p>
        ) : (
          <div className="divide-y divide-border/60">
            {replays.map((r) => (
              <div key={r.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{fmtBytes(r.size_bytes)}</span>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="下载" onClick={() => downloadReplay(inst.id, r.name)}><Download className="h-4 w-4" /></Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="删除" onClick={() => onDelReplay(r)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
        )}
      </PageSurface>
    </div>
  )
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { showToast } = useGlobalToast()
  const [form, setForm] = useState({ name: '', address: '127.0.0.1', port: '25565', authenticate_type: 'offline', username: 'PCRC' })
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!form.name.trim()) return
    setBusy(true)
    try {
      await createPcrc({ name: form.name.trim(), address: form.address.trim(), port: Number(form.port) || 25565, authenticate_type: form.authenticate_type, username: form.username.trim() || 'PCRC' })
      onCreated()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader><DialogTitle>新建录像机</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>名称</Label><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="如 survival-recorder" /></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5"><Label>服务器地址</Label><Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label>端口</Label><Input value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} className="font-mono" /></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>登录方式</Label>
              <Select value={form.authenticate_type} onValueChange={(v) => setForm((f) => ({ ...f, authenticate_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="offline">offline(离线名)</SelectItem>
                  <SelectItem value="microsoft">microsoft(设备码)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>{form.authenticate_type === 'offline' ? '玩家名' : '账号邮箱'}</Label><Input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} /></div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" disabled={busy || !form.name.trim()} onClick={submit}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
