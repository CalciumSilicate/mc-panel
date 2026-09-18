import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { listPlayers, updatePlayer, type PlayerEntry } from '@/api/players'
import { listServers } from '@/api/servers'
import { useAuth } from '@/components/auth-context'
import { QuickEdit } from '@/components/QuickEdit'
import { Pagination } from '@/components/Pagination'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { usePaged } from '@/lib/use-paged'
import { useResource } from '@/lib/use-resource'

const PERMS = ['', 'guest', 'user', 'helper', 'admin', 'owner'].map((value) => ({ value, label: value || '默认权限' }))

export default function Players() {
  const { user } = useAuth()
  const { data: servers } = useResource(() => listServers(), [])
  const mcServers = (servers ?? []).filter((s) => ['vanilla', 'fabric', 'forge'].includes(s.server_type))
  const [chosen, setChosen] = useState<number | null>(null)
  const serverId = chosen ?? mcServers[0]?.id ?? null
  return <PageShell title="玩家管理" description="管理玩家权限与封禁" width="6xl" actions={
    <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setChosen(Number(v))}>
      <SelectTrigger className="w-44" aria-label="服务器"><SelectValue placeholder="选择服务器" /></SelectTrigger>
      <SelectContent>{mcServers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent>
    </Select>
  }>
    {serverId !== null ? <PlayerTable key={serverId} serverId={serverId} editable={['admin', 'owner'].includes(user.role) && !mcServers.find((s) => s.id === serverId)?.protected} /> : <PageSurface>暂无 MC 服务器</PageSurface>}
  </PageShell>
}

function PlayerTable({ serverId, editable }: { serverId: number; editable: boolean }) {
  const { data, loading, error, refresh } = useResource(() => listPlayers(serverId), [serverId])
  const [saved, setSaved] = useState<Record<string, PlayerEntry>>({})
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [op, setOp] = useState('all')
  const [ban, setBan] = useState('all')
  const [perm, setPerm] = useState('all')
  const filtered = useMemo(() => (data ?? []).map((p) => saved[p.name] ?? p).filter((p) =>
    `${p.name} ${p.uuid}`.toLowerCase().includes(q.trim().toLowerCase()) &&
    (status === 'all' || p.online === (status === 'online')) &&
    (op === 'all' || (p.op_level !== null) === (op === 'yes')) &&
    (ban === 'all' || p.banned === (ban === 'yes')) &&
    (perm === 'all' || p.mcdr_perm === (perm === 'default' ? '' : perm))), [data, saved, q, status, op, ban, perm])
  const paged = usePaged(filtered, 20)
  useEffect(() => { paged.setPage(1) }, [q, status, op, ban, perm]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (p: PlayerEntry, patch: Parameters<typeof updatePlayer>[2]) => {
    const updated = await updatePlayer(serverId, p.name, patch)
    setSaved((old) => ({ ...old, [p.name]: updated }))
  }
  return <PageSurface bodyClassName="p-0">
    <div className="flex flex-wrap gap-2 border-b p-4">
      <Input aria-label="搜索玩家" placeholder="搜索玩家名 / UUID" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-44 flex-1" />
      <Filter label="在线状态" value={status} onChange={setStatus} options={[['all', '全部状态'], ['online', '在线'], ['offline', '离线']]} />
      <Filter label="OP 筛选" value={op} onChange={setOp} options={[['all', '全部 OP'], ['yes', 'OP'], ['no', '非 OP']]} />
      <Filter label="封禁筛选" value={ban} onChange={setBan} options={[['all', '全部封禁'], ['yes', '已封禁'], ['no', '未封禁']]} />
      <Filter label="权限筛选" value={perm} onChange={setPerm} options={ [['all', '全部权限'], ...PERMS.map((p) => [p.value || 'default', p.label] as [string, string])]} />
      <Button variant="outline" size="icon" aria-label="刷新" disabled={loading} onClick={() => { setSaved({}); refresh() }}><RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /></Button>
    </div>
    {error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : null}
    <Table>
      <TableHeader><TableRow><TableHead>玩家</TableHead><TableHead>状态</TableHead><TableHead>OP</TableHead><TableHead>封禁</TableHead><TableHead>MCDR 权限</TableHead></TableRow></TableHeader>
      <TableBody>{paged.pageItems.map((p) => <TableRow key={p.name}>
        <TableCell><div className="font-medium">{p.name}</div><div className="text-xs text-muted-foreground">{p.uuid || '—'}</div></TableCell>
        <TableCell className={p.online ? 'text-emerald-500' : 'text-muted-foreground'}>{p.online ? '在线' : '离线'}</TableCell>
        <TableCell><QuickEdit label={`修改 ${p.name} 的 OP`} value={p.op_level === null ? 'no' : 'yes'} display={p.op_level === null ? '未设置' : `OP ${p.op_level}`} options={[{ value: 'no', label: '取消 OP' }, { value: 'yes', label: '设为 OP' }]} disabled={!editable} onSave={(v) => save(p, { op: v === 'yes' })} /></TableCell>
        <TableCell><BanEdit player={p} disabled={!editable} onSave={(patch) => save(p, patch)} /></TableCell>
        <TableCell><QuickEdit label={`修改 ${p.name} 的 MCDR 权限`} value={p.mcdr_perm} display={p.mcdr_perm || '默认权限'} options={PERMS} disabled={!editable} onSave={(v) => save(p, { mcdr_perm: v })} /></TableCell>
      </TableRow>)}{!filtered.length ? <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">{loading ? '加载中…' : '没有匹配的玩家'}</TableCell></TableRow> : null}</TableBody>
    </Table>
    <Pagination page={paged.page} pageCount={paged.pageCount} total={paged.total} onPage={paged.setPage} />
  </PageSurface>
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="w-28"><SelectValue /></SelectTrigger><SelectContent>{options.map(([v, text]) => <SelectItem key={v} value={v}>{text}</SelectItem>)}</SelectContent></Select>
}

function BanEdit({ player, disabled, onSave }: { player: PlayerEntry; disabled: boolean; onSave: (patch: { banned: boolean; ban_reason: string }) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (banned: boolean) => {
    if (busy) return
    setBusy(true); setError('')
    try { await onSave({ banned, ban_reason: reason }); setOpen(false) }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败') }
    finally { setBusy(false) }
  }
  return <Popover open={open} onOpenChange={(v) => { if (busy) return; setOpen(v); if (v) { setReason(player.ban_reason); setError('') } }}>
    <PopoverTrigger asChild><button disabled={disabled} aria-label={`修改 ${player.name} 的封禁`} title={player.ban_reason} className={`-mx-1 rounded px-1 py-1 text-left enabled:hover:bg-primary/10 ${player.banned ? 'text-destructive' : 'text-muted-foreground'}`}>{player.banned ? '已封禁' : '未封禁'}</button></PopoverTrigger>
    <PopoverContent align="start" className="space-y-3">
      <Label htmlFor={`ban-${player.name}`}>封禁原因</Label>
      <Input id={`ban-${player.name}`} value={reason} disabled={busy} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="由管理员封禁" />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">{player.banned ? <Button size="sm" variant="outline" disabled={busy} onClick={() => save(false)}>解除封禁</Button> : null}<Button size="sm" disabled={busy} onClick={() => save(true)}>{busy ? '保存中…' : player.banned ? '保存' : '封禁'}</Button></div>
    </PopoverContent>
  </Popover>
}
