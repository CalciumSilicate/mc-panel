import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { getBlockModelAssets, getEntityModelAssets, getPreviewSkin, type LitematicaPreview } from '@/api/litematica'
import { type ModelAssets, type BakedFace } from '@/lib/block-models'
import { type EntityLayers } from '@/lib/entity-geometry'
import { bakeEntity } from '@/lib/entity-models'
import { bakePreviewBlock } from '@/lib/special-blocks'
import blockNames from '@/lib/blocks.json'
import { Button } from '@/components/ui/button'


const names = new Map(blockNames.map(block => [block.id, block.name]))

export function VoxelPreview({ data }: { data: LitematicaPreview }) {
  const [atlas, setAtlas] = useState<HTMLImageElement | null>(null)
  const [assets, setAssets] = useState<ModelAssets | null>(null)
  const [entityLayers, setEntityLayers] = useState<EntityLayers | null>(null)
  const [textureError, setTextureError] = useState(false)
  const [skins,setSkins]=useState<Record<string,HTMLImageElement>>({})
  const [skinError,setSkinError]=useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const image = new Image()
    image.onload = () => setAtlas(image)
    image.onerror = () => setTextureError(true)
    image.src = '/blocks/models/atlas.png'
    getBlockModelAssets(controller.signal)
      .then(setAssets).catch(() => { if (!controller.signal.aborted) setTextureError(true) })
    getEntityModelAssets(controller.signal)
      .then(setEntityLayers).catch(() => { if (!controller.signal.aborted) setTextureError(true) })
    return () => { controller.abort(); image.onload = null; image.onerror = null }
  }, [])
  const models = useMemo(() => assets && entityLayers ? data.palette.map((id,i) => bakePreviewBlock(assets,entityLayers,id,data.block_states?.[i]?.properties ?? {})) : [], [assets,entityLayers,data.palette,data.block_states])
  const extras = useMemo(() => {
    if(!assets||!entityLayers)return []
    const blocks=new Map(data.blocks.map(b=>[b.slice(0,3).join(','),b]))
    return [...(data.block_entities??[]).flatMap(e=>{
      const block=blocks.get(e.position.join(','))
      return block?[{position:e.position,id:data.palette[block[3]],block:true,...bakePreviewBlock(assets,entityLayers,data.palette[block[3]],data.block_states?.[block[3]]?.properties??{},e.data)}]:[]
    }),...(data.entities??[]).map(e=>({position:e.position,id:e.id,block:false,...bakeEntity(assets,entityLayers,e)}))]
  },[assets,entityLayers,data])
  const skinKeys=useMemo(()=>Array.from(new Set(extras.flatMap(e=>e.faces.flatMap(f=>f.skin?[f.skin]:[])))).sort().join(','),[extras])
  useEffect(()=>{
    const controller=new AbortController()
    if(!skinKeys)return
    // Bound concurrent requests even when a schematic contains many player heads.
    const queue=skinKeys.split(',')
    const loaded:Record<string,HTMLImageElement>={}
    let failed=false
    const load=async()=>{
      while(queue.length&&!controller.signal.aborted) {
        const key=queue.shift()!
        try {
          const blob=await getPreviewSkin(key,controller.signal)
          const image=new Image(),url=URL.createObjectURL(blob)
          try {image.src=url;await image.decode()}finally{URL.revokeObjectURL(url)}
          loaded[key]=image
        } catch {if(!controller.signal.aborted)failed=true}
      }
    }
    void Promise.all([load(),load(),load(),load()]).then(()=>{if(!controller.signal.aborted){setSkins(loaded);setSkinError(failed)}})
    return ()=>controller.abort()
  },[skinKeys])
  const missing = useMemo(() => {
    const overrides=new Map(extras.filter(e=>e.block).map(e=>[e.position.join(','),e]))
    return Array.from(new Set([...data.blocks.filter(b=>(overrides.get(b.slice(0,3).join(','))??models[b[3]])?.unsupported).map(b=>data.palette[b[3]]),...extras.filter(e=>e.unsupported).map(e=>e.id)]))
  }, [data.blocks, data.palette, models, extras])
  const appearanceNotes=Array.from(new Set(extras.flatMap(e=>'warnings' in e?e.warnings??[]:[])))
  const bounds=useMemo(()=>{
    const low=[...data.origin],high=data.origin.map((n,i)=>n+data.size[i])
    for(const e of extras)for(const f of e.faces)for(const p of f.points)for(let i=0;i<3;i++) {low[i]=Math.min(low[i],e.position[i]+p[i]);high[i]=Math.max(high[i],e.position[i]+p[i])}
    return {origin:low,size:high.map((n,i)=>n-low[i])}
  },[data.origin,data.size,extras])
  const scene = useMemo(() => {
    if (!atlas || !assets || !entityLayers) return []
    const tiles = new Map<string, HTMLCanvasElement>()
    const tileFor = (face: BakedFace, shade: number) => {
      const key = `${face.texture}:${face.uv}:${face.rotation}:${face.tint}:${face.opacity}:${shade}:${face.skin}:${JSON.stringify(face.surface)}`
      if (tiles.has(key)) return tiles.get(key)!
      const skin=face.skin?skins[face.skin]:undefined
      const rect=skin?[0,0,skin.width,skin.width]:assets.textureRects?.[face.texture]??[(face.texture%32)*16,Math.floor(face.texture/32)*16,16,16]
      const resolution=face.surface?256:Math.min(256,Math.max(32,Math.ceil(Math.max(Math.abs(face.uv[2]-face.uv[0])*rect[2],Math.abs(face.uv[3]-face.uv[1])*rect[3])/16)))
      const tile = document.createElement('canvas'); tile.width = tile.height = resolution
      const brush = tile.getContext('2d', { willReadFrequently: true })!
      brush.imageSmoothingEnabled=false
      brush.save();brush.translate(resolution/2,resolution/2);brush.rotate(-face.rotation*Math.PI/180);brush.translate(-resolution/2,-resolution/2)
      const [u,v,U,V]=face.uv
      if(face.surface) {
        const {text,color,background,glow}=face.surface
        if(background){brush.fillStyle=background;brush.fillRect(0,0,resolution,resolution)}
        brush.fillStyle=color
        if(text!==undefined){
          const lines=text.split('\n').slice(0,32),lineHeight=resolution/Math.max(4,lines.length)
          brush.font=`${lineHeight*.8}px monospace`;brush.textAlign='center';brush.textBaseline='middle'
          if(glow){brush.shadowColor=color;brush.shadowBlur=2}
          lines.forEach((line,i)=>brush.fillText(line,resolution/2,(i+.5)*lineHeight,resolution-8))
        }else brush.fillRect(0,0,resolution,resolution)
      } else if (atlas && face.texture >= 0) {
        // Negative UV extents mirror the face rather than sampling the adjacent tile.
        brush.translate(U<u?resolution:0,V<v?resolution:0);brush.scale(U<u?-1:1,V<v?-1:1)
        if(Math.abs(U-u)>0 && Math.abs(V-v)>0)brush.drawImage(skin??atlas,rect[0]+Math.min(u,U)/16*rect[2],rect[1]+Math.min(v,V)/16*rect[3],Math.abs(U-u)/16*rect[2],Math.abs(V-v)/16*rect[3],0,0,resolution,resolution)
      } else {
        brush.fillStyle='#312a38';brush.fillRect(0,0,resolution,resolution)
        brush.fillStyle='#b976b9';brush.fillRect(0,0,resolution/2,resolution/2);brush.fillRect(resolution/2,resolution/2,resolution/2,resolution/2)
      }
      brush.restore()
      // Per-pixel multiply preserves cutout alpha (torch stems, rail gaps, plants).
      const pixels=brush.getImageData(0,0,resolution,resolution)
      const tint=document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      tint.fillStyle=face.tint??'#ffffff';tint.fillRect(0,0,1,1)
      const rgb=tint.getImageData(0,0,1,1).data
      for(let i=0;i<pixels.data.length;i+=4) {
        for(let channel=0;channel<3;channel++)pixels.data[i+channel]*=rgb[channel]/255*shade
        pixels.data[i+3]*=face.opacity??1
      }
      brush.putImageData(pixels,0,0)
      tiles.set(key,tile)
      return tile
    }

    const prepared = [...models,...extras].map(model => model.faces.map(face => {
      const shade = face.shade ? 0.6 + 0.4 * Math.max(0, face.normal[1]) + 0.15 * Math.abs(face.normal[0]) : 1
      return { ...face, tile: tileFor(face, shade) }
    }))
    const opaqueTiles = new Map<HTMLCanvasElement, boolean>()
    const opaque = (tile: HTMLCanvasElement) => {
      if (!opaqueTiles.has(tile)) {
        const rgba = tile.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, tile.width, tile.height).data
        let solid = true
        for (let i=3;i<rgba.length;i+=4) if (rgba[i]!==255) { solid=false; break }
        opaqueTiles.set(tile, solid)
      }
      return opaqueTiles.get(tile)!
    }
    // Only fully opaque unit cubes occlude neighbours. Glass and partial models
    // must not hide torches, rail surfaces, stair cutouts, or faces behind them.
    const solid = prepared.map(faces => faces.length === 6 && new Set(faces.map(face=>face.normal.map(Math.round).join(','))).size === 6 && faces.every(face => {
      const axis = face.normal.findIndex(n=>Math.abs(n)>0.9999)
      if (axis < 0 || !opaque(face.tile)) return false
      const boundary = face.normal[axis] > 0 ? 1 : 0
      if (!face.points.every(p=>Math.abs(p[axis]-boundary)<0.0001)) return false
      return [0,1,2].filter(i=>i!==axis).every(i => Math.abs(Math.min(...face.points.map(p=>p[i])))<0.0001 && Math.abs(Math.max(...face.points.map(p=>p[i]))-1)<0.0001)
    }))
    const occupied = new Set(data.blocks.filter(b=>solid[b[3]]).map(b=>`${b[0]},${b[1]},${b[2]}`))
    const center = bounds.origin.map((v,i)=>v+bounds.size[i]/2)
    const replaced=new Set(extras.filter(e=>e.block).map(e=>e.position.join(',')))
    const instances=[...data.blocks.filter(b=>!replaced.has(b.slice(0,3).join(','))),...extras.map((e,i)=>[...e.position,models.length+i])]
    return instances.flatMap(block => (prepared[block[3]] ?? []).filter(face => !face.cull || !occupied.has(face.cull.map((v,i)=>block[i]+Math.round(v)).join(','))).map(face => {
      const points=face.points.map(p=>p.map((v,i)=>v+block[i]-center[i]))
      return { normal:face.normal, tile:face.tile, points, center:[0,1,2].map(i=>points.reduce((sum,p)=>sum+p[i],0)/4) }
    }))
  }, [atlas, assets, entityLayers, models, extras, skins, data.blocks, bounds])
  const canvas = useRef<HTMLCanvasElement>(null)
  const [camera, commitCamera] = useState({ yaw: -0.65, pitch: 0.55, zoom: 1 })
  const pendingCamera = useRef(camera)
  const animationFrame = useRef<number | null>(null)
  const setCamera = useCallback((update: typeof camera | ((previous: typeof camera) => typeof camera)) => {
    pendingCamera.current = typeof update === 'function' ? update(pendingCamera.current) : update
    if (animationFrame.current === null) animationFrame.current = requestAnimationFrame(() => {
      animationFrame.current = null
      commitCamera(pendingCamera.current)
    })
  }, [])
  useEffect(() => () => { if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current) }, [])
  const [dimensions, setDimensions] = useState({ width: 600, height: 420 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(el)
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      setCamera(c => ({ ...c, zoom: Math.max(0.2, Math.min(8, c.zoom * Math.exp(-event.deltaY * 0.001))) }))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => { observer.disconnect(); el.removeEventListener('wheel', wheel) }
  }, [setCamera])
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const { width, height } = dimensions
    const dpr = window.devicePixelRatio || 1
    if (el.width !== Math.round(width*dpr) || el.height !== Math.round(height*dpr)) {
      el.width = Math.round(width*dpr); el.height = Math.round(height*dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, width, height)
    const center = bounds.origin.map((v, i) => v + bounds.size[i] / 2)
    const scale = Math.min(width, height) * 0.68 / Math.max(1, Math.hypot(...bounds.size)) * camera.zoom
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch)
    const project = (p: number[]) => {
      const [x, y, z] = p.map((v, i) => v - center[i])
      const rx = x * cy - z * sy, rz = x * sy + z * cy
      return [width / 2 + rx * scale, height / 2 + (rz * sp - y * cp) * scale, rz * cp + y * sp]
    }
    // Draw the bounding footprint to keep scale and orientation visible.
    const [x, y, z] = data.origin, [sx, , sz] = data.size
    ctx.strokeStyle = '#8b84954d'; ctx.lineWidth = 1
    ctx.beginPath()
    ;[[x,y,z], [x+sx,y,z], [x+sx,y,z+sz], [x,y,z+sz], [x,y,z]].forEach((p,i) => { const q=project(p); if(i===0)ctx.moveTo(q[0],q[1]);else ctx.lineTo(q[0],q[1]) })
    ctx.stroke()
    const visible = scene.filter(face => face.normal[0]*sy*cp + face.normal[1]*sp + face.normal[2]*cy*cp > 0.00001)
      .map(face=>({face,depth:(face.center[0]*sy+face.center[2]*cy)*cp+face.center[1]*sp}))
    visible.sort((a,b)=>a.depth-b.depth)
    const projectRelative = (p:number[]) => [width/2+(p[0]*cy-p[2]*sy)*scale,height/2+((p[0]*sy+p[2]*cy)*sp-p[1]*cp)*scale]
    for (const {face} of visible) {
      const p0=projectRelative(face.points[0]), p1=projectRelative(face.points[1]), p3=projectRelative(face.points[3])
      const ax=(p1[0]-p0[0])/face.tile.width, ay=(p1[1]-p0[1])/face.tile.width, bx=(p3[0]-p0[0])/face.tile.height, by=(p3[1]-p0[1])/face.tile.height
      if(Math.abs(ax*by-bx*ay)<0.0000001) continue
      ctx.setTransform(ax*dpr,ay*dpr,bx*dpr,by*dpr,p0[0]*dpr,p0[1]*dpr)
      ctx.drawImage(face.tile,0,0)
    }
    ctx.setTransform(dpr,0,0,dpr,0,0)
    ctx.fillStyle='#9b95a5';ctx.font='12px sans-serif'
    ctx.fillText(`X ${sx} · Y ${data.size[1]} · Z ${sz}`,16,height-16)
  }, [data.origin, data.size, bounds, camera, dimensions, scene])
  return <div className="relative overflow-hidden rounded-xl border bg-muted/20">
    {skinError&&<p role="status" className="absolute bottom-16 left-3 rounded bg-background/90 px-3 py-2 text-xs text-muted-foreground">部分玩家皮肤加载失败，暂用默认皮肤。</p>}
    {!!appearanceNotes.length&&<p role="status" className="absolute bottom-16 right-3 max-w-[75%] rounded bg-background/90 px-3 py-2 text-xs text-muted-foreground">{appearanceNotes.join('；')}</p>}
    {(!atlas || !assets || !entityLayers || missing.length > 0) && <p role="status" className="absolute left-3 top-3 max-h-24 max-w-[90%] overflow-auto rounded bg-background/90 px-3 py-2 text-xs text-muted-foreground">{textureError ? '纹理加载失败，请刷新重试' : !atlas || !assets || !entityLayers ? '加载方块模型与纹理…' : `外观未完整支持：${missing.map(id => names.get(id) ?? id).join("、")}`}</p>}
    <canvas ref={canvas} className="h-[420px] w-full touch-none cursor-grab active:cursor-grabbing" aria-label="投影三维预览，拖动旋转；使用下方按钮旋转或缩放" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY}}} onPointerMove={e=>{if(!drag.current)return;const dx=e.clientX-drag.current.x,dy=e.clientY-drag.current.y;drag.current={x:e.clientX,y:e.clientY};setCamera(c=>({...c,yaw:c.yaw+dx*0.01,pitch:Math.max(0.1,Math.min(1.5,c.pitch+dy*0.01))}))}} onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}} onLostPointerCapture={()=>{drag.current=null}} />
    {!data.blocks.length && !data.entities?.length && <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">当前范围没有方块或实体</p>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
      <span className="text-xs text-muted-foreground">拖动旋转 · 滚轮缩放 · Java 26.3 模型与贴图</span>
      <div className="flex gap-1"><Button variant="ghost" size="sm" onClick={()=>setCamera(c=>({...c,yaw:c.yaw+Math.PI/4}))}>旋转</Button><Button variant="ghost" size="icon" aria-label="放大" onClick={()=>setCamera(c=>({...c,zoom:Math.min(8,c.zoom*1.25)}))}><ZoomIn className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="缩小" onClick={()=>setCamera(c=>({...c,zoom:Math.max(0.2,c.zoom/1.25)}))}><ZoomOut className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="重置视角" onClick={()=>setCamera({yaw:-0.65,pitch:0.55,zoom:1})}><RotateCcw className="h-4 w-4" /></Button></div>
    </div>
  </div>
}
