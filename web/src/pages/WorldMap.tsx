import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type MapPlayer, getMapPlayers, getMapPositions, refreshMap } from '@/api/worldmap'
import { type ServerSummary, listServers } from '@/api/servers'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
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

type Tracks = Record<string, [number, number, number][]>

function MapCanvas({ tracks, players, colorOf }: { tracks: Tracks; players: MapPlayer[]; colorOf: (uuid: string) => string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0b0b10'
    ctx.fillRect(0, 0, W, H)

    const pts: [number, number][] = []
    for (const arr of Object.values(tracks)) for (const p of arr) pts.push([p[0], p[2]])
    if (pts.length === 0) {
      ctx.fillStyle = '#888'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('暂无轨迹数据', W / 2, H / 2)
      return
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z) }
    // 至少 64 格视野,留 8% 边距
    const spanX = Math.max(maxX - minX, 64), spanZ = Math.max(maxZ - minZ, 64)
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
    const pad = 40
    const scale = Math.min((W - pad * 2) / (spanX * 1.16), (H - pad * 2) / (spanZ * 1.16))
    const toPx = (x: number, z: number): [number, number] => [W / 2 + (x - cx) * scale, H / 2 + (z - cz) * scale]

    // 网格(世界坐标对齐到 nice 间隔)
    const niceStep = (span: number) => {
      const raw = span / 6
      const pow = Math.pow(10, Math.floor(Math.log10(raw)))
      const m = raw / pow
      return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * pow
    }
    const step = niceStep(Math.max(spanX, spanZ) * 1.16)
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
  }, [tracks, players, colorOf])

  return <canvas ref={ref} width={1000} height={620} className="w-full rounded-lg border border-border/70" />
}

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
  const [scannedAt, setScannedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

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
    getMapPlayers(serverId).then((r) => {
      setPlayers(r.players); setScannedAt(r.scanned_at); setSelected(new Set(r.players.map((p) => p.uuid)))
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

  return (
    <PageShell
      title="世界地图"
      description="玩家位置轨迹(俯视 x-z)。每 5 分钟采集一次,位置变化才记录。"
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
            <Button type="button" variant="outline" className="gap-2" onClick={doRefresh} disabled={loading}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />刷新
            </Button>
          </div>
        ) : null
      }
    >
      {mcServers.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有 MC 服务器实例。</p></PageSurface>
      ) : (
        <div className="flex gap-4">
          <div className="min-w-0 flex-1">
            <MapCanvas tracks={tracks} players={players} colorOf={colorOf} />
          </div>
          <div className="hidden w-48 shrink-0 lg:block">
            <PageSurface title="玩家" bodyClassName="p-2 max-h-[620px] overflow-y-auto">
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
          </div>
        </div>
      )}
    </PageShell>
  )
}
