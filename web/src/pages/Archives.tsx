import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive as ArchiveIcon, Download, Loader2, Pencil, RefreshCw, RotateCcw, Save, Trash2, Upload } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type Archive,
  createArchiveFromServer,
  deleteArchive,
  downloadArchive,
  listArchives,
  restoreArchive,
  updateArchive,
  uploadArchiveWithProgress,
} from '@/api/archives'
import { pollJob } from '@/api/jobs'
import { type ServerSummary, listServers } from '@/api/servers'
import { useAuth } from '@/components/auth-context'
import { useConfirm } from '@/components/ui/dialog-context'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

function fmtSize(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

export default function Archives() {
  const confirm = useConfirm()
  const { user, roleAtLeast, canOperate } = useAuth()
  const canHelper = roleAtLeast('helper')
  const mine = (a: Archive) => canHelper || a.owner_user_id === user.id
  const { showToast } = useGlobalToast()
  const { data, loading, error, refresh } = useResource(() => listArchives(), [])
  const { data: servers } = useResource(() => listServers(), [])
  const [createOpen, setCreateOpen] = useState(false)
  const [restoreFor, setRestoreFor] = useState<Archive | null>(null)
  const [editFor, setEditFor] = useState<Archive | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [uploadPct, setUploadPct] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const serverName = (id: number | null) =>
    (servers ?? []).find((s) => s.id === id)?.name ?? (id ? `#${id}` : '上传')

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(-1)
    setUploadPct(0)
    try {
      await uploadArchiveWithProgress(file, setUploadPct)
      showToast('success', '已上传存档')
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '上传失败')
    } finally {
      setBusy(null)
      setUploadPct(0)
    }
  }

  const onDownload = async (a: Archive) => {
    setBusy(a.id)
    try {
      await downloadArchive(a.id, a.name, a.filename)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '下载失败')
    } finally {
      setBusy(null)
    }
  }

  const onDelete = async (a: Archive) => {
    if (!(await confirm({ title: `删除存档「${a.name}」?`, confirmText: '删除', destructive: true }))) return
    setBusy(a.id)
    try {
      await deleteArchive(a.id)
      showToast('success', '已删除')
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '删除失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="存档管理"
      description="把实例的世界打包成存档,或恢复到任意实例。默认需先停止，也可选择强制停止后创建/恢复。"
      width="7xl"
      actions={
        <>
          <input ref={fileRef} type="file" accept=".zip,.tar,.tar.gz,.tgz,.tar.bz2,.tbz2,.tar.xz,.txz" className="hidden" onChange={onUpload} />
          <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </Button>
          {canOperate ? (
            <Button type="button" variant="outline" className="gap-2" onClick={() => fileRef.current?.click()} disabled={busy === -1}>
              {busy === -1 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {busy === -1 ? `上传中 ${uploadPct}%` : '上传'}
            </Button>
          ) : null}
          {canHelper ? (
            <Button type="button" className="gap-2" onClick={() => setCreateOpen(true)}>
              <Save className="h-4 w-4" />
              从服务器创建
            </Button>
          ) : null}
        </>
      }
    >
      <PageSurface bodyClassName="p-0">
        {loading && !data ? (
          <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : !data || data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <ArchiveIcon className="h-8 w-8 opacity-40" />
            还没有存档。
          </div>
        ) : (
          <div className="ops-table-shell border-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="text-muted-foreground">{a.mc_version || '—'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[11px]">
                        {a.source === 'uploaded' ? '上传' : serverName(a.source_server_id)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{fmtSize(a.size)}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(a.created_at).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {mine(a) ? (
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" disabled={busy === a.id} title="下载" onClick={() => onDownload(a)}>
                            {busy === a.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          </Button>
                        ) : null}
                        {canOperate ? (
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" disabled={busy === a.id} title="恢复" onClick={() => setRestoreFor(a)}>
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {mine(a) ? (
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" disabled={busy === a.id} title="编辑" onClick={() => setEditFor(a)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {mine(a) ? (
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" disabled={busy === a.id} title="删除" onClick={() => onDelete(a)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageSurface>

      <ServerPickDialog
        open={createOpen}
        title="从服务器创建存档"
        description="选择要打包世界的实例；默认需已停止，可选强制创建。"
        confirmLabel="创建"
        servers={servers ?? []}
        onClose={() => setCreateOpen(false)}
        run={(serverId, force, onProgress) =>
          createArchiveFromServer(serverId, force).then(({ job_id }) => pollJob(job_id, onProgress))
        }
        onDone={() => {
          setCreateOpen(false)
          refresh()
        }}
      />

      <ServerPickDialog
        open={restoreFor !== null}
        title={`恢复存档 —— ${restoreFor?.name ?? ''}`}
        description="选择要恢复到的实例；默认需已停止，可选强制恢复。恢复前会备份其现有世界。"
        confirmLabel="恢复"
        servers={servers ?? []}
        blockProtected
        onClose={() => setRestoreFor(null)}
        run={(serverId, force, onProgress) =>
          restoreArchive(restoreFor!.id, serverId, force).then(({ job_id }) => pollJob(job_id, onProgress))
        }
        onDone={() => setRestoreFor(null)}
      />

      <EditArchiveDialog
        archive={editFor}
        onClose={() => setEditFor(null)}
        onSaved={() => {
          setEditFor(null)
          refresh()
        }}
      />
    </PageShell>
  )
}

function EditArchiveDialog({
  archive,
  onClose,
  onSaved,
}: {
  archive: Archive | null
  onClose: () => void
  onSaved: () => void
}) {
  const { showToast } = useGlobalToast()
  const [name, setName] = useState('')
  const [mcVersion, setMcVersion] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (archive) {
      setName(archive.name)
      setMcVersion(archive.mc_version)
    }
  }, [archive])

  const save = async () => {
    if (!archive) return
    setBusy(true)
    try {
      await updateArchive(archive.id, { name: name.trim(), mc_version: mcVersion.trim() })
      showToast('success', '已保存')
      onSaved()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={archive !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑存档</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="arc-name">名称</Label>
            <Input id="arc-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="arc-ver">MC 版本</Label>
            <Input id="arc-ver" value={mcVersion} onChange={(e) => setMcVersion(e.target.value)} placeholder="如 1.20.1" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ServerPickDialog({
  open,
  title,
  description,
  confirmLabel,
  servers,
  onClose,
  run,
  onDone,
  blockProtected = false,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  servers: ServerSummary[]
  onClose: () => void
  run: (serverId: number, force: boolean, onProgress: (pct: number | null) => void) => Promise<{ status: string; message: string }>
  onDone: () => void
  blockProtected?: boolean
}) {
  const { showToast } = useGlobalToast()
  const { roleAtLeast } = useAuth()
  const canStopProtected = roleAtLeast('admin')
  const [serverId, setServerId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  const [force, setForce] = useState(false)

  const selectable = useCallback((s: ServerSummary) =>
    s.status !== 'installing' &&
    s.status !== 'queued' &&
    (!blockProtected || !s.protected) &&
    (!(s.status === 'running' || s.status === 'starting') ||
      (force && (!s.protected || canStopProtected))),
  [force, blockProtected, canStopProtected])

  useEffect(() => {
    if (open) {
      setForce(false)
      setServerId(null)
      setPct(null)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setServerId((current) => servers.some((s) => s.id === current && selectable(s))
        ? current : servers.find(selectable)?.id ?? null)
    }
  }, [open, servers, selectable])

  const selectedValid = servers.some((s) => s.id === serverId && selectable(s))

  const confirm = async () => {
    if (serverId === null || !selectedValid) return
    setBusy(true)
    setPct(null)
    try {
      const final = await run(serverId, force, setPct)
      if (final.status === 'error') showToast('error', final.message || '操作失败')
      else {
        showToast('success', '完成')
        onDone()
      }
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Select value={serverId === null ? '' : String(serverId)} disabled={busy} onValueChange={(v) => setServerId(Number(v))}>
            <SelectTrigger><SelectValue placeholder="选择服务器" /></SelectTrigger>
            <SelectContent>
              {servers.map((s) => (
                <SelectItem key={s.id} value={String(s.id)} disabled={!selectable(s)}>
                  {s.name}
                  {s.status === 'installing' ? '(安装中,不可选)'
                    : s.status === 'queued' ? '(启动队列中,不可选)'
                      : s.protected && !selectable(s) ? '(受保护,不可选)'
                        : s.status === 'running' ? (selectable(s) ? '(运行中,将强制停止)' : '(运行中,不可选)')
                          : s.status === 'starting' ? (selectable(s) ? '(启动中,将强制停止)' : '(启动中,不可选)')
                            : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <Switch checked={force} disabled={busy} onCheckedChange={setForce} aria-label={`强制${confirmLabel}`} />
            强制{confirmLabel}
          </label>
          {force ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              将先强制停止目标实例再{confirmLabel}存档。强制停止可能导致未保存的数据丢失或世界损坏，建议优先正常停止。操作后不会自动启动实例。
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">运行中或启动中的实例需先停止，或勾选强制{confirmLabel}。</p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" className="min-w-24 gap-2" onClick={confirm} disabled={busy || !selectedValid}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {pct != null ? `${pct}%` : '处理中'}
              </>
            ) : (
              force ? `强制${confirmLabel}` : confirmLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
