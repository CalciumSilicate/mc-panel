import { useEffect, useMemo, useState } from 'react'
import { Copy, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react'

import { ApiError } from '@/api/client'
import { listServers } from '@/api/servers'
import { applySuperflat } from '@/api/tools'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const BIOMES = [
  'plains', 'desert', 'forest', 'savanna', 'taiga', 'snowy_plains', 'swamp',
  'jungle', 'badlands', 'mushroom_fields', 'windswept_hills', 'river', 'beach',
]
const STRUCTURES = [
  'village', 'pillager_outpost', 'stronghold', 'mineshaft', 'ruined_portal',
  'shipwreck', 'monument', 'desert_pyramid', 'igloo', 'jungle_pyramid',
  'swamp_hut', 'ancient_city',
]
const DEFAULT_LAYERS = [
  { block: 'minecraft:bedrock', height: 1 },
  { block: 'minecraft:dirt', height: 2 },
  { block: 'minecraft:grass_block', height: 1 },
]

interface Layer {
  block: string
  height: number
}

export default function Superflat() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const [serverId, setServerId] = useState<number | null>(null)
  const [layers, setLayers] = useState<Layer[]>(DEFAULT_LAYERS)
  const [biome, setBiome] = useState('plains')
  const [structures, setStructures] = useState<string[]>(['village'])
  const [overwrite, setOverwrite] = useState(false)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (serverId === null && servers && servers.length > 0) setServerId(servers[0].id)
  }, [servers, serverId])

  const generatorSettings = useMemo(
    () =>
      JSON.stringify({
        layers: layers.map((l) => ({ block: l.block, height: Number(l.height) || 1 })),
        biome: `minecraft:${biome}`,
        ...(structures.length ? { structure_overrides: structures.map((s) => `minecraft:${s}`) } : {}),
      }),
    [layers, biome, structures],
  )

  const setLayer = (i: number, patch: Partial<Layer>) =>
    setLayers((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))

  const toggleStructure = (s: string) =>
    setStructures((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  const apply = async () => {
    if (serverId === null) return
    if (layers.length === 0) {
      showToast('error', '至少需要一层')
      return
    }
    setApplying(true)
    try {
      await applySuperflat({
        server_id: serverId,
        layers: layers.map((l) => ({ block: l.block.trim(), height: Number(l.height) || 1 })),
        biome: `minecraft:${biome}`,
        structures: structures.map((s) => `minecraft:${s}`),
        overwrite,
      })
      showToast('success', overwrite ? '已应用并重置世界' : '已应用到 server.properties')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '应用失败')
    } finally {
      setApplying(false)
    }
  }

  return (
    <PageShell
      title="超平坦世界"
      description="配置超平坦预设并写入实例的 server.properties(level-type=flat)。对新世界生效。"
      width="6xl"
      actions={
        <div className="flex items-center gap-2">
          <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
            <SelectTrigger className="w-44"><SelectValue placeholder="选择服务器" /></SelectTrigger>
            <SelectContent>
              {(servers ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      <div className="space-y-6">
        <PageSurface title="分层(从底到顶)" bodyClassName="space-y-3">
          {layers.map((l, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                {i === 0 ? <Label className="text-xs text-muted-foreground">方块</Label> : null}
                <Input value={l.block} onChange={(e) => setLayer(i, { block: e.target.value })} className="font-mono" placeholder="minecraft:dirt" />
              </div>
              <div className="w-24 space-y-1.5">
                {i === 0 ? <Label className="text-xs text-muted-foreground">层数</Label> : null}
                <Input value={String(l.height)} onChange={(e) => setLayer(i, { height: Number(e.target.value) || 1 })} inputMode="numeric" />
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" onClick={() => setLayers((prev) => prev.filter((_, idx) => idx !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setLayers((prev) => [...prev, { block: 'minecraft:stone', height: 1 }])}>
              <Plus className="h-4 w-4" />
              添加层
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setLayers(DEFAULT_LAYERS)}>
              恢复默认
            </Button>
          </div>
        </PageSurface>

        <PageSurface title="生物群系与结构" bodyClassName="space-y-4">
          <div className="space-y-2 sm:max-w-xs">
            <Label>生物群系</Label>
            <Select value={biome} onValueChange={setBiome}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {BIOMES.map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>结构(可多选)</Label>
            <div className="flex flex-wrap gap-2">
              {STRUCTURES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStructure(s)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    structures.includes(s)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border/70 text-muted-foreground hover:bg-muted',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </PageSurface>

        <PageSurface title="预设预览 (generator-settings)" bodyClassName="space-y-3">
          <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/40 p-3 font-mono text-xs">{generatorSettings}</pre>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => { navigator.clipboard?.writeText(generatorSettings); showToast('success', '已复制') }}>
            <Copy className="h-3.5 w-3.5" />
            复制
          </Button>
        </PageSurface>

        <PageSurface>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <label className="flex items-center gap-3">
              <Switch checked={overwrite} onCheckedChange={setOverwrite} />
              <span>
                <span className="block text-sm font-medium">重置世界</span>
                <span className="block text-xs text-muted-foreground">删除现有世界目录使其按新预设重新生成(需实例已停止)</span>
              </span>
            </label>
            <Button type="button" className="gap-2" onClick={apply} disabled={applying || serverId === null}>
              {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              应用到服务器
            </Button>
          </div>
        </PageSurface>
      </div>
    </PageShell>
  )
}
