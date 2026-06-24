import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type MapMarker,
  type MapPlayer,
  createMarker,
  deleteMarker,
  getMapPlayers,
  getMapPositions,
  getMarkers,
  refreshMap,
  updateMarker,
} from '@/api/worldmap'
import { type ServerSummary, listServers } from '@/api/servers'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn, fmtRefreshed } from '@/lib/utils'

const MC_TYPES = ['vanilla', 'fabric', 'forge']
const DIMS = [
  { key: 'minecraft:overworld', label: '主世界' },
  { key: 'minecraft:the_nether', label: '下界' },
  { key: 'minecraft:the_end', label: '末地' },
]
const WINDOWS = [
  { key: 24, label: '近 24 小时' },
  { key: 168, label: '近 7 天' },
  { key: 720, label: '近 30 天' },
  { key: 8760, label: '近 1 年' },
]
const COLORS = ['#a78bfa', '#34d399', '#60a5fa', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c', '#f87171', '#a3e635', '#e879f9']
const ICONS = ['📍', '🏠', '🏰', '⭐', '⚓', '🔥', '💎', '🚪', '🌳', '⛏️']
const MARKER_COLORS = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#22d3ee', '#e5e7eb']

const CANVAS_W = 1000
const CANVAS_H = 620

type Tracks = Record<string, [number, number, number][]>

function MapCanvas({
  tracks,
  markers,
  players,
  colorOf,
  onAddMarker,
}: {
  tracks: Tracks
  markers: MapMarker[]
  players: MapPlayer[]
  colorOf: (uuid: string) => string
  onAddMarker: (x: number, z: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  // 视图变换:由轨迹点 + 地标共同决定取景范围,供绘制(toPx)与点击反算(toWorld)复用。
  const view = useMemo(() => {
    const pts: [number, number][] = []
    for (const arr of Object.values(tracks)) for (const p of arr) pts.push([p[0], p[2]])
    for (const m of markers) pts.push([m.x, m.z])
    if (pts.length === 0) return null
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z) }
    const spanX = Math.max(maxX - minX, 64), spanZ = Math.max(maxZ - minZ, 64)
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
    const pad = 40
    const scale = Math.min((CANVAS_W - pad * 2) / (spanX * 1.16), (CANVAS_H - pad * 2) / (spanZ * 1.16))
    const toPx = (x: number, z: number): [number, number] => [CANVAS_W / 2 + (x - cx) * scale, CANVAS_H / 2 + (z - cz) * scale]
    const toWorld = (px: number, py: number): [number, number] => [cx + (px - CANVAS_W / 2) / scale, cz + (py - CANVAS_H / 2) / scale]
    return { toPx, toWorld, scale, cx, cz, spanX, spanZ }
  }, [tracks, markers])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0b0b10'
    ctx.fillRect(0, 0, W, H)

    if (!view) {
      ctx.fillStyle = '#888'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('暂无轨迹与地标数据(点击地图可添加地标)', W / 2, H / 2)
      return
    }
    const { toPx, scale, cx, cz } = view

    // 网格(世界坐标对齐到 nice 间隔)
    const niceStep = (span: number) => {
      const raw = span / 6
      const pow = Math.pow(10, Math.floor(Math.log10(raw)))
      const m = raw / pow
      return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * pow
    }
    const step = niceStep(Math.max(view.spanX, view.spanZ) * 1.16)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '10px monospace'
    ctx.lineWidth = 1
    const startX = Math.ceil((cx - W / 2 / scale) / step) * step
    for (let gx = startX; (gx - cx) * scale + W / 2 < W; gx += step) {
      const [px] = toPx(gx, 0)
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
      ctx.textAlign = 'left'; ctx.fillText(String(gx), px + 2, 12)
    }
    const startZ = Math.ceil((cz - H / 2 / scale) / step) * step
    for (let gz = startZ; (gz - cz) * scale + H / 2 < H; gz += step) {
      const [, py] = toPx(0, gz)
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke()
      ctx.textAlign = 'left'; ctx.fillText(String(gz), 2, py - 2)
    }

    // 轨迹
    for (const [uuid, arr] of Object.entries(tracks)) {
      if (arr.length === 0) continue
      const color = colorOf(uuid)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      arr.forEach((p, i) => {
        const [px, py] = toPx(p[0], p[2])
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
      // 起点(绿)终点(红)
      const [sx, sy] = toPx(arr[0][0], arr[0][2])
      const [ex, ey] = toPx(arr[arr.length - 1][0], arr[arr.length - 1][2])
      ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill()
    }

    // 地标(POI)
    for (const m of markers) {
      const [px, py] = toPx(m.x, m.z)
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2)
      ctx.fillStyle = m.color; ctx.fill()
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke()
      ctx.textAlign = 'center'
      ctx.font = '14px sans-serif'
      ctx.fillText(m.icon || '📍', px, py - 9)
      ctx.fillStyle = '#e5e7eb'; ctx.font = '11px sans-serif'
      ctx.fillText(m.name, px, py + 18)
    }
  }, [tracks, markers, players, colorOf, view])

  const handleClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const canvas = ref.current
    if (!canvas) return
    if (!view) { onAddMarker(0, 0); return }
    const rect = canvas.getBoundingClientRect()
    const px = (e.clientX - rect.left) * (CANVAS_W / rect.width)
    const py = (e.clientY - rect.top) * (CANVAS_H / rect.height)
    const [wx, wz] = view.toWorld(px, py)
    onAddMarker(Math.round(wx), Math.round(wz))
  }

  return (
    <canvas
      ref={ref}
      width={CANVAS_W}
      height={CANVAS_H}
      onClick={handleClick}
      className="w-full cursor-crosshair rounded-lg border border-border/70"
    />
  )
}

type MarkerForm = { id: number | null; name: string; x: string; y: string; z: string; icon: string; color: string }
const EMPTY_FORM: MarkerForm = { id: null, name: '', x: '0', y: '64', z: '0', icon: '📍', color: '#f87171' }

export default function WorldMap() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const mcServers = useMemo<ServerSummary[]>(() => (servers ?? []).filter((s) => MC_TYPES.includes(s.server_type)), [servers])
  const [serverId, setServerId] = useState<number | null>(null)
  const [dim, setDim] = useState('minecraft:overworld')
  const [hours, setHours] = useState(168)
  const [players, setPlayers] = useState<MapPlayer[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tracks, setTracks] = useState<Tracks>({})
  const [markers, setMarkers] = useState<MapMarker[]>([])
  const [scannedAt, setScannedAt] = useState<number | null>(null)
  const [rconEnabled, setRconEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<MarkerForm>(EMPTY_FORM)
  const [formOpen, setFormOpen] = useState(false)
  const [savingMarker, setSavingMarker] = useState(false)

  const dimLabel = DIMS.find((d) => d.key === dim)?.label ?? dim

  const colorOf = useMemo(() => {
    const idx: Record<string, number> = {}
    players.forEach((p, i) => { idx[p.uuid] = i })
    return (uuid: string) => COLORS[(idx[uuid] ?? 0) % COLORS.length]
  }, [players])

  useEffect(() => {
    if (serverId === null && mcServers.length > 0) setServerId(mcServers[0].id)
  }, [mcServers, serverId])

  useEffect(() => {
    if (serverId === null) return
    setRconEnabled(null)
    getMapPlayers(serverId).then((r) => {
      setPlayers(r.players); setScannedAt(r.scanned_at); setSelected(new Set(r.players.map((p) => p.uuid)))
      setRconEnabled(r.rcon_enabled)
    }).catch(() => undefined)
  }, [serverId])

  const loadTracks = async () => {
    if (serverId === null) return
    setLoading(true)
    try {
      const r = await getMapPositions(serverId, [...selected], dim, hours)
      setTracks(r.tracks)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { loadTracks() }, [serverId, dim, hours, selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMarkers = async () => {
    if (serverId === null) return
    try {
      const r = await getMarkers(serverId, dim)
      setMarkers(r.markers)
    } catch {
      setMarkers([])
    }
  }
  useEffect(() => { loadMarkers() }, [serverId, dim]) // eslint-disable-line react-hooks/exhaustive-deps

  const doRefresh = async () => {
    if (serverId === null) return
    setLoading(true)
    try {
      const r = await refreshMap(serverId)
      setScannedAt(r.scanned_at)
      await loadTracks()
      showToast('success', '已刷新')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '刷新失败')
    } finally {
      setLoading(false)
    }
  }

  const toggle = (uuid: string) => setSelected((cur) => {
    const n = new Set(cur)
    if (n.has(uuid)) n.delete(uuid)
    else n.add(uuid)
    return n
  })

  const openAdd = (x: number, z: number) => { setForm({ ...EMPTY_FORM, x: String(x), z: String(z) }); setFormOpen(true) }
  const openEdit = (m: MapMarker) => {
    setForm({ id: m.id, name: m.name, x: String(m.x), y: String(m.y), z: String(m.z), icon: m.icon, color: m.color })
    setFormOpen(true)
  }

  const saveMarker = async () => {
    if (serverId === null) return
    if (!form.name.trim()) { showToast('error', '请输入地标名称'); return }
    setSavingMarker(true)
    try {
      const input = {
        dim, name: form.name.trim(),
        x: Number(form.x) || 0, y: Number(form.y) || 64, z: Number(form.z) || 0,
        icon: form.icon, color: form.color,
      }
      if (form.id === null) await createMarker(serverId, input)
      else await updateMarker(serverId, form.id, input)
      setFormOpen(false)
      await loadMarkers()
      showToast('success', form.id === null ? '已添加地标' : '已更新地标')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setSavingMarker(false)
    }
  }

  const removeMarker = async (m: MapMarker) => {
    if (serverId === null) return
    try {
      await deleteMarker(serverId, m.id)
      await loadMarkers()
      showToast('success', '已删除地标')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '删除失败')
    }
  }

  return (
    <PageShell
      title="世界地图"
      description="玩家位置轨迹(俯视 x-z,RCON 实时采集)+ 自定义地标。点击地图可在该处添加地标。"
      width="6xl"
      actions={
        mcServers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">{fmtRefreshed(scannedAt)}</span>
            <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
              <SelectTrigger className="w-36"><SelectValue placeholder="选择服务器" /></SelectTrigger>
              <SelectContent>{mcServers.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>))}</SelectContent>
            </Select>
            <Select value={dim} onValueChange={setDim}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>{DIMS.map((d) => (<SelectItem key={d.key} value={d.key}>{d.label}</SelectItem>))}</SelectContent>
            </Select>
            <Select value={String(hours)} onValueChange={(v) => setHours(Number(v))}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{WINDOWS.map((w) => (<SelectItem key={w.key} value={String(w.key)}>{w.label}</SelectItem>))}</SelectContent>
            </Select>
            <Button type="button" variant="outline" className="gap-2" onClick={doRefresh} disabled={loading || rconEnabled === false}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />刷新
            </Button>
          </div>
        ) : null
      }
    >
      {mcServers.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有 MC 服务器实例。</p></PageSurface>
      ) : rconEnabled === false ? (
        <PageSurface>
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-sm font-medium">该实例未启用 RCON</p>
            <p className="max-w-md text-xs text-muted-foreground">
              世界地图通过 RCON 采集玩家实时位置。请到「实例 → 编辑 → 高级」开启 RCON,并重启实例后生效。
            </p>
          </div>
        </PageSurface>
      ) : (
        <div className="flex gap-4">
          <div className="min-w-0 flex-1">
            <MapCanvas tracks={tracks} markers={markers} players={players} colorOf={colorOf} onAddMarker={openAdd} />
          </div>
          <div className="hidden w-52 shrink-0 space-y-4 lg:block">
            <PageSurface title="玩家" bodyClassName="p-2 max-h-[280px] overflow-y-auto">
              {players.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">暂无</p>
              ) : (
                players.map((p) => (
                  <button key={p.uuid} type="button" className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted" onClick={() => toggle(p.uuid)}>
                    <span className={cn('h-3 w-3 shrink-0 rounded-full border', selected.has(p.uuid) ? '' : 'opacity-25')} style={{ backgroundColor: colorOf(p.uuid) }} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </button>
                ))
              )}
            </PageSurface>
            <PageSurface
              title={`地标 · ${dimLabel}`}
              bodyClassName="p-2 max-h-[300px] overflow-y-auto"
              actions={
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => openAdd(0, 0)}>
                  <Plus className="h-3.5 w-3.5" />添加
                </Button>
              }
            >
              {markers.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">该维度暂无地标。点击地图空白处即可添加。</p>
              ) : (
                markers.map((m) => (
                  <div key={m.id} className="group flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                    <span className="shrink-0 text-base leading-none">{m.icon}</span>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openEdit(m)}>
                      <span className="block truncate font-medium" style={{ color: m.color }}>{m.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{Math.round(m.x)}, {Math.round(m.y)}, {Math.round(m.z)}</span>
                    </button>
                    <button type="button" className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" onClick={() => removeMarker(m)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </PageSurface>
          </div>
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={(o) => (!o ? setFormOpen(false) : undefined)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{form.id === null ? '添加地标' : '编辑地标'} · {dimLabel}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="marker-name">名称</Label>
              <Input id="marker-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="如:出生点 / 主城 / 末地传送门" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="marker-x">X</Label>
                <Input id="marker-x" type="number" value={form.x} onChange={(e) => setForm((f) => ({ ...f, x: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="marker-y">Y</Label>
                <Input id="marker-y" type="number" value={form.y} onChange={(e) => setForm((f) => ({ ...f, y: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="marker-z">Z</Label>
                <Input id="marker-z" type="number" value={form.z} onChange={(e) => setForm((f) => ({ ...f, z: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>图标</Label>
              <div className="flex flex-wrap gap-1.5">
                {ICONS.map((ic) => (
                  <button key={ic} type="button" onClick={() => setForm((f) => ({ ...f, icon: ic }))}
                    className={cn('flex h-8 w-8 items-center justify-center rounded border text-lg', form.icon === ic ? 'border-primary bg-primary/10' : 'border-border/70 hover:bg-muted')}>
                    {ic}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>颜色</Label>
              <div className="flex flex-wrap gap-1.5">
                {MARKER_COLORS.map((c) => (
                  <button key={c} type="button" onClick={() => setForm((f) => ({ ...f, color: c }))}
                    className={cn('h-7 w-7 rounded-full border-2', form.color === c ? 'border-foreground' : 'border-transparent')}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setFormOpen(false)} disabled={savingMarker}>取消</Button>
            <Button type="button" onClick={saveMarker} disabled={savingMarker}>{savingMarker ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
