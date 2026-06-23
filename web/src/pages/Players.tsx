import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type PlayerEntry, listPlayers } from '@/api/players'
import { type ServerSummary, listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { Pagination } from '@/components/Pagination'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { usePaged } from '@/lib/use-paged'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const MC_TYPES = ['vanilla', 'fabric', 'forge']
const PERM_TONE: Record<string, string> = {
  owner: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  admin: 'border-primary/30 bg-primary/10 text-primary',
  helper: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  user: 'border-border/70 bg-muted text-muted-foreground',
  guest: 'border-border/70 bg-muted text-muted-foreground',
}

export default function Players() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const mcServers = useMemo<ServerSummary[]>(() => (servers ?? []).filter((s) => MC_TYPES.includes(s.server_type)), [servers])
  const [serverId, setServerId] = useState<number | null>(null)
  const [rows, setRows] = useState<PlayerEntry[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    return k ? rows.filter((r) => r.name.toLowerCase().includes(k)) : rows
  }, [rows, q])
  const paged = usePaged(filtered, 20)

  useEffect(() => {
    if (serverId === null && mcServers.length > 0) setServerId(mcServers[0].id)
  }, [mcServers, serverId])

  const load = async () => {
    if (serverId === null) return
    setLoading(true)
    try {
      setRows(await listPlayers(serverId))
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [serverId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageShell
      title="玩家管理"
      description="查看玩家在该子服内的 OP 等级、封禁状态与 MCDR 权限。"
      width="5xl"
      actions={
        mcServers.length > 0 ? (
          <div className="flex items-center gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索玩家" className="w-40" />
            <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
              <SelectTrigger className="w-40"><SelectValue placeholder="选择服务器" /></SelectTrigger>
              <SelectContent>{mcServers.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>))}</SelectContent>
            </Select>
            <Button type="button" variant="outline" className="gap-2" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />刷新
            </Button>
          </div>
        ) : null
      }
    >
      {mcServers.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有 MC 服务器实例。</p></PageSurface>
      ) : (
        <PageSurface bodyClassName="p-0">
          {loading && rows.length === 0 ? (
            <div className="py-10"><InlineLoader /></div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无玩家记录。</p>
          ) : (
            <div className="px-2 pb-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>玩家</TableHead>
                    <TableHead>OP</TableHead>
                    <TableHead>封禁</TableHead>
                    <TableHead>MCDR 权限</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.pageItems.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        {p.op_level != null ? <Badge variant="outline" className="text-[11px] text-amber-600 dark:text-amber-400 border-amber-500/40">OP {p.op_level}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {p.banned ? <Badge variant="outline" className="text-[11px] text-destructive border-destructive/40" title={p.ban_reason}>已封禁</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {p.mcdr_perm ? <Badge variant="outline" className={cn('text-[11px]', PERM_TONE[p.mcdr_perm])}>{p.mcdr_perm}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination page={paged.page} pageCount={paged.pageCount} total={paged.total} onPage={paged.setPage} />
            </div>
          )}
        </PageSurface>
      )}
    </PageShell>
  )
}
