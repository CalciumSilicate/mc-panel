import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, History, Loader2, RefreshCw, Upload } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type PBBackupItem, type PBOverview, pbExport, pbImport, pbList, pbOverview, pbRestore, pbUsage } from '@/api/pb'
import { type ServerSummary, listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageStat, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'

const MC_TYPES = ['vanilla', 'fabric', 'forge']

function fmtBytes(n?: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

export default function PrimeBackup() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const mcServers = useMemo<ServerSummary[]>(() => (servers ?? []).filter((s) => MC_TYPES.includes(s.server_type)), [servers])
  const [serverId, setServerId] = useState<number | null>(null)
  const [overview, setOverview] = useState<PBOverview | null>(null)
  const [usage, setUsage] = useState<number>(0)
  const [list, setList] = useState<PBBackupItem[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<number | 'import' | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<PBBackupItem | null>(null)
  const [restoreTo, setRestoreTo] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (serverId === null && mcServers.length > 0) setServerId(mcServers[0].id)
  }, [mcServers, serverId])

  const reload = async (sid: number) => {
    setLoading(true)
    try {
      const [ov, ls, us] = await Promise.all([pbOverview(sid), pbList(sid), pbUsage(sid)])
      setOverview(ov); setList(ls); setUsage(us)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (serverId !== null) reload(serverId) }, [serverId]) // eslint-disable-line react-hooks/exhaustive-deps

  const onExport = async (b: PBBackupItem) => {
    setBusy(b.id)
    try { await pbExport(serverId!, b.id) } catch (err) { showToast('error', err instanceof ApiError ? err.message : '导出失败') } finally { setBusy(null) }
  }

  const onImport = async (file: File) => {
    if (serverId === null) return
    setBusy('import')
    try {
      await pbImport(serverId, file)
      showToast('success', '已导入')
      reload(serverId)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '导入失败')
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const doRestore = async () => {
    if (!restoreTarget || serverId === null || restoreTo === null) return
    setBusy(restoreTarget.id)
    try {
      await pbRestore(serverId, restoreTarget.id, restoreTo)
      showToast('success', '已恢复到目标服务器')
      setRestoreTarget(null)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '恢复失败')
    } finally {
      setBusy(null)
    }
  }

  const dedup = overview && overview.blob_raw_size && overview.blob_stored_size
    ? `${(100 - (overview.blob_stored_size / overview.blob_raw_size) * 100).toFixed(0)}%`
    : '—'

  return (
    <PageShell
      title="Prime Backup"
      description="增量去重备份的查看 / 导出 / 导入 / 恢复(把 PB 插件作为 CLI 调用)。"
      width="5xl"
      actions={
        mcServers.length > 0 ? (
          <div className="flex gap-2">
            <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
              <SelectTrigger className="w-48"><SelectValue placeholder="选择服务器" /></SelectTrigger>
              <SelectContent>
                {mcServers.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" className="gap-2" onClick={() => serverId !== null && reload(serverId)} disabled={loading}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />刷新
            </Button>
          </div>
        ) : null
      }
    >
      {mcServers.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有 MC 服务器实例。</p></PageSurface>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PageStat label="备份数" value={String(overview?.backup_amount ?? 0)} />
            <PageStat label="库占用" value={fmtBytes(usage)} />
            <PageStat label="原始大小" value={fmtBytes(overview?.blob_raw_size)} />
            <PageStat label="去重率" value={dedup} />
          </div>

          <PageSurface
            title="备份列表"
            actions={
              <>
                <input ref={fileRef} type="file" accept=".tar,.zip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f) }} />
                <Button type="button" variant="outline" className="gap-2" disabled={busy === 'import'} onClick={() => fileRef.current?.click()}>
                  {busy === 'import' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}导入
                </Button>
              </>
            }
            bodyClassName="p-0"
          >
            {loading ? (
              <div className="py-10"><InlineLoader /></div>
            ) : list.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">没有备份(或该实例未安装 Prime Backup)。</p>
            ) : (
              <div className="divide-y divide-border/60">
                {list.map((b) => (
                  <div key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="w-10 shrink-0 font-mono text-muted-foreground">#{b.id}</span>
                    <span className="w-40 shrink-0">{b.date}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{b.comment || '—'}{b.creator ? ` · ${b.creator}` : ''}</span>
                    <span className="w-20 shrink-0 text-right font-mono text-xs">{fmtBytes(b.stored_size)}</span>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="导出" disabled={busy === b.id} onClick={() => onExport(b)}>
                      {busy === b.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => { setRestoreTarget(b); setRestoreTo(null) }}>
                      <History className="h-3.5 w-3.5" />恢复
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </PageSurface>
        </div>
      )}

      <Dialog open={restoreTarget !== null} onOpenChange={(o) => (!o ? setRestoreTarget(null) : undefined)}>
        <DialogContent>
          <DialogHeader><DialogTitle>恢复备份 #{restoreTarget?.id}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">把该备份的世界恢复到目标服务器(目标须已停止,原世界会被改名备份)。</p>
          <Select value={restoreTo === null ? undefined : String(restoreTo)} onValueChange={(v) => setRestoreTo(Number(v))}>
            <SelectTrigger><SelectValue placeholder="选择目标服务器" /></SelectTrigger>
            <SelectContent>
              {mcServers.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}{s.id === serverId ? '(本服)' : ''}</SelectItem>))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRestoreTarget(null)}>取消</Button>
            <Button type="button" variant="destructive" className="gap-1.5" disabled={restoreTo === null || busy === restoreTarget?.id} onClick={doRestore}>
              {busy === restoreTarget?.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}确认恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
