/** Vanilla blockstate selection and JSON model baking. Geometry is in block units. */
export type Vec3 = [number, number, number]
type Direction = 'up' | 'down' | 'north' | 'south' | 'east' | 'west'
interface ModelFace { texture: string; uv?: number[]; rotation?: number; tintindex?: number; cullface?: Direction }
interface Element { from: Vec3; to: Vec3; faces: Partial<Record<Direction, ModelFace>>; rotation?: { origin: Vec3; axis?: 'x' | 'y' | 'z'; angle?: number; x?: number; y?: number; z?: number; rescale?: boolean }; shade?: boolean }
interface Model { parent?: string; textures?: Record<string,string | {sprite:string;force_translucent?:boolean}>; elements?: Element[]; display?: Record<string, {rotation?: Vec3;translation?: Vec3;scale?: Vec3}> }
interface Variant { model: string; x?: number; y?: number; uvlock?: boolean }
type Choice = Variant | Variant[]
type Condition = { [key: string]: string | Condition[] }
export interface ItemNode { type: string; model?: string | {type: string; [key: string]: unknown}; base?: string; models?: ItemNode[]; fallback?: ItemNode; on_false?: ItemNode; on_true?: ItemNode; cases?: {when: string | string[]; model: ItemNode}[]; entries?: {threshold: number; model: ItemNode}[]; property?: string; [key: string]: unknown }
export interface EntityVariant {asset_id?:string;baby_asset_id?:string;model?:string;assets?:Record<string,string>;baby_assets?:Record<string,string>}
export interface ModelAssets { version: string; models: Record<string,Model>; states: Record<string,{ variants?: Record<string,Choice>; multipart?: { when?: Condition; apply: Choice }[] }>; textures: Record<string,number>; textureRects?: number[][]; defaults?: Record<string,Record<string,string>>; items?: Record<string,{model: ItemNode}>; itemContours?: Record<string,[string,number,number,number,number,number][]>; paintings?: Record<string,{asset_id:string;width:number;height:number}>; equipment?: Record<string,{layers: Record<string,{texture: string; dyeable?: unknown}[]>}>; variants?:Record<string,Record<string,EntityVariant>> }
export interface BakedFace { points: Vec3[]; normal: Vec3; uv: number[]; rotation: number; texture: number; tint?: string; opacity?:number; shade: boolean; cull?: Vec3; skin?:string; surface?: {text?:string;color:string;background?:string;glow?:boolean} }
export interface BakedModel { faces: BakedFace[]; unsupported: boolean }
const names = (id: string) => id.replace(/^minecraft:/, '')
const normals: Record<Direction,Vec3> = { up:[0,1,0],down:[0,-1,0],north:[0,0,-1],south:[0,0,1],east:[1,0,0],west:[-1,0,0] }

export function rotate(p: Vec3, axis: string, degrees: number, origin: Vec3 = [0,0,0], rescale = false): Vec3 {
  const a = degrees * Math.PI/180, c = Math.cos(a), s = Math.sin(a)
  const v = p.map((n,i)=>n-origin[i]) as Vec3
  const [i,j] = axis==='x' ? [1,2] : axis==='y' ? [2,0] : [0,1]
  const u=v[i], w=v[j]
  v[i]=(u*c-w*s)*(rescale?1/Math.cos(a):1);v[j]=(u*s+w*c)*(rescale?1/Math.cos(a):1)
  return v.map((n,i)=>n+origin[i]) as Vec3
}
function matches(condition: Condition | undefined, props: Record<string,string>): boolean {
  if (!condition) return true
  return Object.entries(condition).every(([key,value]) => key==='OR' ? (value as Condition[]).some(c=>matches(c,props)) : key==='AND' ? (value as Condition[]).every(c=>matches(c,props)) : (value as string).split('|').includes(props[key]))
}
export function inherit(assets: ModelAssets, id: string, chain = new Set<string>()): Model | null {
  id = names(id)
  if(chain.has(id)) return null
  const model = assets.models[id]
  if(!model) return null
  chain.add(id)
  const parent = model.parent ? inherit(assets,model.parent,chain) : null
  return { textures:{...parent?.textures,...model.textures}, elements:model.elements ?? parent?.elements, display:{...parent?.display,...model.display} }
}
function vertices(d: Direction, a: Vec3,b:Vec3): Vec3[] {
  const [x,y,z]=a,[X,Y,Z]=b
  return {up:[[x,Y,z],[X,Y,z],[X,Y,Z],[x,Y,Z]],down:[[x,y,Z],[X,y,Z],[X,y,z],[x,y,z]],north:[[X,Y,z],[x,Y,z],[x,y,z],[X,y,z]],south:[[x,Y,Z],[X,Y,Z],[X,y,Z],[x,y,Z]],east:[[X,Y,Z],[X,Y,z],[X,y,z],[X,y,Z]],west:[[x,Y,z],[x,Y,Z],[x,y,Z],[x,y,z]]}[d] as Vec3[]
}
function defaultUV(d: Direction,a:Vec3,b:Vec3): number[] {
  const [x,y,z]=a,[X,Y,Z]=b
  return {up:[x,z,X,Z],down:[x,16-Z,X,16-z],north:[16-X,16-Y,16-x,16-y],south:[x,16-Y,X,16-y],east:[16-Z,16-Y,16-z,16-y],west:[z,16-Y,Z,16-y]}[d]
}
function tintFor(id: string, props: Record<string,string>): string {
  if (id==='minecraft:redstone_wire') {
    const power=Math.max(0,Math.min(15,Number(props.power)||0))/15
    return `rgb(${Math.round((power===0?0.3:power*0.6+0.4)*255)},${Math.round(Math.max(0,power*power*0.7-0.5)*255)},${Math.round(Math.max(0,power*power*0.6-0.7)*255)})`
  }
  return id.includes('water') ? '#3f76e4' : '#91bd59'
}

export function bakeBlock(assets: ModelAssets, id: string, props: Record<string,string> = {}): BakedModel {
  props={...assets.defaults?.[names(id)],...props}
  const state=assets.states[names(id)]
  if(!state) return {faces:[],unsupported:true}
  const choices: Variant[]=[]
  // Weighted visual alternatives are intentionally deterministic for stable previews.
  const choose=(choice:Choice)=>choices.push(Array.isArray(choice)?choice[0]:choice)
  if(state.variants) {
    const match=Object.entries(state.variants).find(([key])=>!key || key.split(',').every(pair=>{const [k,v]=pair.split('=');return v.split('|').includes(props[k])}))
    if(match) choose(match[1])
  }
  for(const part of state.multipart ?? []) if(matches(part.when,props)) choose(part.apply)
  const faces:BakedFace[]=[]
  let unsupported=!choices.length && !state.multipart
  for(const variant of choices) {
    const model=inherit(assets,variant.model)
    if(!model?.elements?.length) {unsupported=true;continue}
    const blockRotate=(v:Vec3,origin:Vec3=[8,8,8])=>rotate(rotate(v,'x',-(variant.x??0),origin),'y',-(variant.y??0),origin)
    for(const element of model.elements) for(const [key,face] of Object.entries(element.faces)) {
      const direction=key as Direction
      let texture=face.texture
      if(!texture.startsWith('#') && model.textures?.[texture])texture='#'+texture
      const seen=new Set<string>()
      while(texture.startsWith('#') && !seen.has(texture)) { seen.add(texture);const value=model.textures?.[texture.slice(1)];texture=typeof value==='string'?value:value?.sprite??'missing' }
      const index=assets.textures[names(texture)]??-1
      if(index<0) unsupported=true
      const elementRotate=(v:Vec3,normal=false)=> {
        const r=element.rotation
        if(!r)return v
        const origin:Vec3=normal?[0,0,0]:r.origin??[8,8,8]
        return r.axis?rotate(v,r.axis,r.angle??0,origin,!normal&&r.rescale):rotate(rotate(rotate(v,'x',r.x??0,origin),'y',r.y??0,origin),'z',r.z??0,origin)
      }
      const transform=(v:Vec3)=>blockRotate(elementRotate(v)).map(n=>n/16) as Vec3
      let normal=normals[direction]
      if(element.rotation) normal=elementRotate(normal,true)
      normal=blockRotate(normal,[0,0,0])
      let rotation=face.rotation??0
      if(variant.uvlock) {
        // Keep the texture's up-vector aligned with the corresponding world face.
        const worldDirection=(Object.keys(normals) as Direction[]).find(d=>normals[d].every((n,i)=>Math.abs(n-normal[i])<0.001))
        if(worldDirection) {
          const source=vertices(direction,[0,0,0],[16,16,16])
          const world=vertices(worldDirection,[0,0,0],[16,16,16])
          const transformed=source.map(v=>blockRotate(v))
          const offset=world.findIndex(v=>v.every((n,i)=>Math.abs(n-transformed[0][i])<0.001))
          if(offset>=0) rotation=(rotation+offset*90)%360
        }
      }
      faces.push({ points:vertices(direction,element.from,element.to).map(transform),normal,uv:face.uv??defaultUV(direction,element.from,element.to),rotation,texture:index,tint:face.tintindex!==undefined?tintFor(id,props):undefined,shade:element.shade!==false,cull:face.cullface && normals[face.cullface]?blockRotate(normals[face.cullface],[0,0,0]):undefined })
    }
  }
  return {faces,unsupported}
}

export function bakeModel(assets: ModelAssets, model: string): BakedModel {
  return bakeBlock({...assets,states:{__preview:{variants:{'':{model}}}}},'__preview')
}
