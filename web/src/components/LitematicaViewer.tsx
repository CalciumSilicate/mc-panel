import { useState } from 'react'
import { getLitematicaPreview } from '@/api/litematica'
import { useResource } from '@/lib/use-resource'
import { VoxelPreview } from '@/components/VoxelPreview'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { InlineLoader } from '@/components/PageLoader'

export function LitematicaViewer({ name }: { name: string }) {
  const [layer, setLayer] = useState<number | null>(null)
  const [region, setRegion] = useState('')
  const { data, loading, refreshing, error, refresh } = useResource(signal => getLitematicaPreview(name, layer, region, signal), [name, layer, region], { keepPreviousData: true })
  const meta = data
  return <div className="space-y-4" aria-busy={refreshing}>
    {meta && <>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span>尺寸 <strong className="font-mono">{meta.size.join(' × ')}</strong></span>
        <span className="text-muted-foreground">起点 {meta.origin.join(', ')} · {meta.regions.length} 个区域</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm">区域<Select value={region ? `region:${region}` : "all"} onValueChange={value=>setRegion(value === "all" ? "" : value.slice(7))}><SelectTrigger aria-label="预览区域" className="h-9 w-52"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部区域</SelectItem>{meta.regions.map(r=><SelectItem key={r.name} value={`region:${r.name}`}>{r.name} ({r.size.join('×')})</SelectItem>)}</SelectContent></Select></div>
        <Button size="sm" variant={layer===null?'secondary':'outline'} onClick={()=>setLayer(null)}>完整投影</Button>
        <Button size="sm" variant={layer!==null?'secondary':'outline'} onClick={()=>setLayer(meta.origin[1])}>单层查看</Button>
        {layer!==null && <label className="flex flex-1 items-center gap-3 text-sm"><span className="whitespace-nowrap font-mono">Y = {layer}</span><input className="min-w-24 flex-1 accent-primary" aria-label="预览层高" type="range" min={meta.origin[1]} max={meta.origin[1]+meta.size[1]-1} value={layer} onChange={e=>setLayer(Number(e.target.value))} /><input type="number" className="h-9 w-20 rounded-md border bg-background px-2" aria-label="输入层高" min={meta.origin[1]} max={meta.origin[1]+meta.size[1]-1} value={layer} onChange={e=>{const value=e.target.valueAsNumber;if(Number.isInteger(value))setLayer(Math.max(meta.origin[1],Math.min(meta.origin[1]+meta.size[1]-1,value)))}} /></label>}
      </div>
    </>}
    {error && <div role="alert" className="flex items-center gap-3 text-sm text-destructive">{error}<Button size="sm" variant="outline" onClick={refresh}>重试</Button></div>}
    {loading ? <div className="flex h-[480px] items-center justify-center" role="status"><InlineLoader />生成预览…</div> : data && <>
      <VoxelPreview data={data} />
      <p className="text-xs text-muted-foreground">当前范围 {data.total_blocks.toLocaleString()} 个方块 · 已显示 {data.blocks.length.toLocaleString()} 个。{data.sampled ? '此范围较大，当前为抽样预览；可选择区域或单层查看更多细节。' : '显示当前范围内全部非空气方块。'}实体 {data.entities?.length??0} / {data.total_entities??0}。{data.entities_sampled?'实体较多，仅显示前 512 个。':''}使用 Java 26.3 原版模型与贴图，按保存的状态静态预览。{refreshing ? '更新中…' : ''}</p>
    </>}
  </div>
}
