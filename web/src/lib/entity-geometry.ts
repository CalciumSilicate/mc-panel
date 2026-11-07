import { rotate, type BakedFace, type Vec3 } from './block-models'

export interface ModelPart {
  x: number; y: number; z: number; xRot: number; yRot: number; zRot: number
  xScale: number; yScale: number; zScale: number
  visible?:boolean
  faces: {normal: Vec3; vertices: [number,number,number,number,number][]}[]
  children: Record<string,ModelPart>
}
export type EntityLayers = Record<string,ModelPart>
export type Pose = Record<string,Partial<ModelPart> & {hidden?: boolean}>
export interface Transform { translation?: Vec3; rotation?: Vec3; scale?: Vec3 }
const degrees = 180/Math.PI

export function transformPoint(p: Vec3, t: Transform, normal = false): Vec3 {
  let v=p.map((n,i)=>normal ? n/(t.scale?.[i]??1) : n*(t.scale?.[i]??1)) as Vec3
  for(const [i,axis] of ['x','y','z'].entries()) v=rotate(v,axis,t.rotation?.[i]??0)
  return v.map((n,i)=>n+(normal?0:t.translation?.[i]??0)) as Vec3
}
export function transformFaces(faces: BakedFace[], t: Transform): BakedFace[] {
  return faces.map(f=>({...f,points:f.points.map(p=>transformPoint(p,t)),normal:normalize(transformPoint(f.normal,t,true)),cull:undefined}))
}
function normalize(v:Vec3):Vec3 {const length=Math.hypot(...v)||1;return v.map(n=>n/length) as Vec3}

export function partTransforms(layers:EntityLayers,key:string,name:string,pose:Pose={}):Transform[] {
  function find(p:ModelPart,n:string,parents:Transform[]):Transform[]|undefined {
    const part={...p,...pose[n]}
    const chain:Transform[]=[{translation:[part.x/16,part.y/16,part.z/16],rotation:[part.xRot*degrees,part.yRot*degrees,part.zRot*degrees],scale:[part.xScale,part.yScale,part.zScale]},...parents]
    if(n===name)return chain
    for(const [child,p] of Object.entries(part.children)) {const result=find(p,child,chain);if(result)return result}
  }
  const root=layers[key.startsWith('minecraft:')?key:`minecraft:${key}`]
  return root?find(root,'root',[])??[]:[]
}

/** Preserve the client's part hierarchy, pivot rotations and per-face UVs. */
export function bakeLayer(layers: EntityLayers, key: string, texture: number | ((part:string)=>number), pose: Pose = {}): BakedFace[] {
  const root=layers[key.startsWith('minecraft:')?key:`minecraft:${key}`]
  if(!root)return []
  const result:BakedFace[]=[]
  function visit(part:ModelPart,name:string,parents:Transform[]) {
    const p={...part,...pose[name]}
    if(p.hidden||p.visible===false)return
    const chain:Transform[]=[{translation:[p.x,p.y,p.z],rotation:[p.xRot*degrees,p.yRot*degrees,p.zRot*degrees],scale:[p.xScale,p.yScale,p.zScale]},...parents]
    const point=(v:Vec3,normal=false)=>chain.reduce((a,t)=>transformPoint(a,t,normal),v).map(n=>normal?n:n/16) as Vec3
    for(const f of p.faces) {
      const u=Math.min(...f.vertices.map(v=>v[3])),U=Math.max(...f.vertices.map(v=>v[3]))
      const v=Math.min(...f.vertices.map(v=>v[4])),V=Math.max(...f.vertices.map(v=>v[4]))
      if(U-u<1e-8||V-v<1e-8)continue
      const ordered=[[u,v],[U,v],[U,V],[u,V]].map(uv=>f.vertices.find(p=>Math.abs(p[3]-uv[0])<1e-6&&Math.abs(p[4]-uv[1])<1e-6))
      if(ordered.some(p=>!p))continue
      result.push({points:ordered.map(p=>point(p!.slice(0,3) as Vec3)),normal:normalize(point(f.normal,true)),uv:[u*16,v*16,U*16,V*16],texture:typeof texture==='number'?texture:texture(name),rotation:0,shade:true})
    }
    for(const [child,childPart] of Object.entries(p.children))visit(childPart,child,chain)
  }
  visit(root,'root',[])
  return result
}

export function plane(texture:number,width=1,height=1):BakedFace[] {
  const points:Vec3[]=[[-width/2,height/2,0],[width/2,height/2,0],[width/2,-height/2,0],[-width/2,-height/2,0]]
  return [{points,normal:[0,0,1],texture,uv:[0,0,16,16],rotation:0,shade:false},{points,normal:[0,0,-1],texture,uv:[0,0,16,16],rotation:0,shade:false}]
}
export const object = (v:unknown):Record<string,unknown>=>v && typeof v==='object' && !Array.isArray(v)?v as Record<string,unknown>:{}
export const array = (v:unknown):unknown[]=>Array.isArray(v)?v:[]
export const number = (v:unknown,fallback=0):number=>typeof v==='number'&&Number.isFinite(v)?v:fallback
export const string = (v:unknown,fallback=''):string=>typeof v==='string'?v:fallback
export const short = (v:unknown,fallback=''):string=>string(v,fallback).replace(/^minecraft:/,'')
export const dyeNames = ['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black']
export const dyeColors = ['#f9fffe','#f9801d','#c74ebd','#3ab3da','#fed83d','#80c71f','#f38baa','#474f52','#9d9d97','#169c9c','#8932b8','#3c44aa','#835432','#5e7c16','#b02e26','#1d1d21']
export const dye = (v:unknown):string=>dyeColors[typeof v==='number'?Math.max(0,Math.min(15,v)):Math.max(0,dyeNames.indexOf(short(v))) ]

export function chatText(value:unknown,depth=0):string {
  if(depth>8)return ''
  if(typeof value==='string') {
    if(value.startsWith('{')||value.startsWith('[')||value.startsWith('"'))try {return chatText(JSON.parse(value),depth+1)}catch{/* literal text */}
    return value.slice(0,2048)
  }
  if(Array.isArray(value))return value.map(v=>chatText(v,depth+1)).join('').slice(0,2048)
  const data=object(value)
  return (string(data.text)||string(data.translate)) + array(data.extra).map(v=>chatText(v,depth+1)).join('').slice(0,2048)
}
