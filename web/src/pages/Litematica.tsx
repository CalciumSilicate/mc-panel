import { useEffect, useRef, useState } from 'react'
import { Box, Download, Hammer, Info, Loader2, Trash2, Upload } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type LitematicaFile,
  type LitematicaInfo,
  buildLitematica,
  deleteLitematica,
  downloadLitematica,
  getLitematicaInfo,
  listLitematica,
  uploadLitematica,
} from '@/api/litematica'
import { type ServerSummary, listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useConfirm } from '@/components/ui/dialog-context'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'

const MC_TYPES = ['vanilla', 'fabric', 'forge']

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

const blockName = (id: string) => id.replace(/^minecraft:/, '').replace(/_/g, ' ')

export default function Litematica() {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const { data: servers } = useResource(() => listServers(), [])
  const { data: files, loading, refresh } = useResource(() => listLitematica(), [])
  const mcServers = (servers ?? []).filter((s) => MC_TYPES.includes(s.server_type))
  const [busy, setBusy] = useState<string | null>(null)
  const [info, setInfo] = useState<{ name: string; data: LitematicaInfo } | null>(null)
  const [buildFor, setBuildFor] = useState<LitematicaFile | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onUpload = async (file: File) => {
    setBusy('upload')
    try {
      await uploadLitematica(file)
      showToast('success', '已上传并解析')
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '上传失败')
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const showInfo = async (f: LitematicaFile) => {
    setBusy(f.name)
    try {
      setInfo({ name: f.name, data: await getLitematicaInfo(f.name) })
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '解析失败')
    } finally {
      setBusy(null)
    }
  }

  const onDelete = async (f: LitematicaFile) => {
    if (!(await confirm({ title: `删除投影「${f.name}」?`, confirmText: '删除', destructive: true }))) return
    setBusy(f.name)
    try {
      await deleteLitematica(f.name)
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '删除失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="Litematica 投影"
      description="上传 .litematic → 查看材料清单 → 在运行中的服务器里逐条建造(投影打印)。"
      width="5xl"
      actions={
        <>
          <input ref={fileRef} type="file" accept=".litematic" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f) }} />
          <Button type="button" className="gap-2" disabled={busy === 'upload'} onClick={() => fileRef.current?.click()}>
            {busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}上传投影
          </Button>
        </>
      }
    >
      <PageSurface bodyClassName="p-0">
        {loading ? (
          <div className="py-10"><InlineLoader /></div>
        ) : (files ?? []).length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">还没有投影文件,点右上角上传 .litematic。</p>
        ) : (
          <div className="divide-y divide-border/60">
            {(files ?? []).map((f) => (
              <div key={f.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Box className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{fmtBytes(f.size_bytes)}</span>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="信息/材料" disabled={busy === f.name} onClick={() => showInfo(f)}>
                  {busy === f.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Info className="h-4 w-4" />}
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="下载" onClick={() => downloadLitematica(f.name)}>
                  <Download className="h-4 w-4" />
                </Button>
                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setBuildFor(f)}>
                  <Hammer className="h-3.5 w-3.5" />建造
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="删除" onClick={() => onDelete(f)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </PageSurface>

      {/* 信息/材料 */}
      <Dialog open={info !== null} onOpenChange={(o) => (!o ? setInfo(null) : undefined)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{info?.name}</DialogTitle></DialogHeader>
          {info ? (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                尺寸 {info.data.size.join(' × ')} · 区域 {info.data.regions} · 方块 {info.data.total_blocks.toLocaleString()}
              </div>
              <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-2">
                {info.data.materials.map((m) => (
                  <div key={m.id} className="flex items-center justify-between px-2 py-1 text-sm">
                    <span className="truncate capitalize">{blockName(m.id)}</span>
                    <span className="font-mono text-muted-foreground">{m.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {buildFor ? <BuildDialog file={buildFor} servers={mcServers} onClose={() => setBuildFor(null)} /> : null}
    </PageShell>
  )
}

function BuildDialog({ file, servers, onClose }: { file: LitematicaFile; servers: ServerSummary[]; onClose: () => void }) {
  const { showToast } = useGlobalToast()
  const [serverId, setServerId] = useState<number | null>(servers[0]?.id ?? null)
  const [coords, setCoords] = useState({ x: '0', y: '64', z: '0' })
  const [placeAir, setPlaceAir] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (serverId === null && servers.length > 0) setServerId(servers[0].id) }, [servers, serverId])

  const submit = async () => {
    if (serverId === null) return
    setBusy(true)
    try {
      const r = await buildLitematica({ name: file.name, server_id: serverId, x: Number(coords.x) || 0, y: Number(coords.y) || 0, z: Number(coords.z) || 0, place_air: placeAir })
      showToast('success', `已下发 ${r.commands} 条指令,正在建造…`)
      onClose()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '建造失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader><DialogTitle>建造「{file.name}」</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>目标服务器(需运行中)</Label>
            <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
              <SelectTrigger><SelectValue placeholder="选择服务器" /></SelectTrigger>
              <SelectContent>
                {servers.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(['x', 'y', 'z'] as const).map((k) => (
              <div key={k} className="space-y-1.5">
                <Label className="uppercase">{k} 原点</Label>
                <Input value={coords[k]} onChange={(e) => setCoords((c) => ({ ...c, [k]: e.target.value }))} className="font-mono" />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <Label>放置空气(覆盖原有方块)</Label>
            <Switch checked={placeAir} onCheckedChange={setPlaceAir} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" className="gap-1.5" disabled={busy || serverId === null} onClick={submit}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hammer className="h-4 w-4" />}开始建造
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
