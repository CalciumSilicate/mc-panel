import { bakeModel, inherit, type BakedFace, type BakedModel, type ItemNode, type ModelAssets, type Vec3 } from './block-models'
import { array, bakeLayer, number, object, short, string, transformFaces, plane, type EntityLayers } from './entity-geometry'
import { bakePreviewBlock } from './special-blocks'

/** Resolve static item appearance at the same display context used by the client. */
export function bakeItem(assets:ModelAssets,layers:EntityLayers,raw:unknown,context='fixed'):BakedModel {
  const item=object(raw),id=short(item.id),components=object(item.components)
  if(!id||id==='air')return {faces:[],unsupported:false}
  const modelId=short(components['minecraft:item_model'],id)
  const model=assets.items?.[modelId]?.model
  function resolve(node:ItemNode|undefined,depth=0):BakedModel {
    if(!node||depth>12)return {faces:[],unsupported:true}
    const type=short(node.type)
    if(type==='empty')return {faces:[],unsupported:false}
    if(type==='composite') {
      const results=(node.models??[]).map(m=>resolve(m,depth+1))
      return {faces:results.flatMap(m=>m.faces),unsupported:results.some(m=>m.unsupported)}
    }
    if(type==='condition')return resolve(node.on_false,depth+1)
    if(type==='select') {
      const value=short(node.property)==='display_context'?context:short(node.property)==='trim_material'?string(object(components['minecraft:trim']).material):undefined
      return resolve(node.cases?.find(c=>value&&(Array.isArray(c.when)?c.when:[c.when]).includes(value))?.model??node.fallback,depth+1)
    }
    if(type==='range_dispatch')return resolve(node.fallback??node.entries?.[0]?.model,depth+1)
    if(type==='special') {
      const special=object(node.model),kind=short(special.type)
      if(kind==='trident'||kind==='shield') {
        const tex=assets.textures[kind==='trident'?'entity/trident/trident':'entity/shield/shield_base_nopattern']??-1
        return {faces:transformFaces(bakeLayer(layers,`${kind}#main`,tex),{scale:[1,-1,-1]}),unsupported:tex<0}
      }
      const blockId=kind==='head'?short(special.kind,'player')+(short(special.kind).endsWith('skeleton')?'_skull':'_head'):id
      const result=bakePreviewBlock(assets,layers,'minecraft:'+blockId,{}, {...object(components['minecraft:block_entity_data']),profile:components['minecraft:profile'],patterns:components['minecraft:banner_patterns']})
      return applyDisplay(result,string(node.base,`item/${id}`))
    }
    if(type==='model'&&typeof node.model==='string') {
      const definition=inherit(assets,node.model)
      let result=bakeModel(assets,node.model)
      if(!definition?.elements?.length&&definition?.textures) {
        const faces=Object.entries(definition.textures).filter(([key])=>/^layer\d+$/.test(key)).flatMap(([key,value])=>{
          const textureName=short(typeof value==='string'?value:value.sprite),texture=assets.textures[textureName]??-1
          const faces=generatedItem(assets,textureName,texture)
          const source=object(array(node.tints)[Number(key.slice(5))])
          const color=short(source.type)==='dye'?number(object(components['minecraft:dyed_color']).rgb??components['minecraft:dyed_color']??object(object(item.tag).display).color,number(source.default,0xa06540)):short(source.type)==='potion'?number(object(components['minecraft:potion_contents']).custom_color,number(source.default,0x385dc6)):typeof source.value==='number'?source.value:undefined
          return transformFaces(faces.map(f=>({...f,tint:color===undefined?undefined:'#'+(color&0xffffff).toString(16).padStart(6,'0')})),{translation:[0,0,Number(key.slice(5))*.001]})
        })
        result={faces,unsupported:!faces.length||faces.some(f=>f.texture<0)}
      }
      return applyDisplay(result,node.model)
    }
    return {faces:[],unsupported:true}
  }
  function applyDisplay(result:BakedModel,modelName:string):BakedModel {
    const display=inherit(assets,modelName)?.display?.[context]
    const centered=transformFaces(result.faces,{translation:[-.5,-.5,-.5]})
    return {...result,faces:transformFaces(centered,{rotation:display?.rotation,scale:display?.scale,translation:display?.translation?.map(n=>n/16) as Vec3|undefined})}
  }
  return resolve(model)
}

function generatedItem(assets:ModelAssets,key:string,texture:number):BakedFace[] {
  const front=transformFaces(plane(texture),{translation:[.5,.5,.5]})
  front[0].points=front[0].points.map(p=>[p[0],p[1],p[2]+1/32])
  front[1].points=front[1].points.map(p=>[p[0],p[1],p[2]-1/32])
  for(const [direction,start,end,row,w,h] of assets.itemContours?.[key]??[]) {
    let points:Vec3[],normal:Vec3,uv:number[]
    if(direction==='up'||direction==='down') {
      const y=1-(row+(direction==='down'?1:0))/h
      points=[[start/w,y,15/32],[end/w,y,15/32],[end/w,y,17/32],[start/w,y,17/32]]
      normal=[0,direction==='up'?1:-1,0];uv=[start/w*16,row/h*16,end/w*16,(row+1)/h*16]
    }else {
      const x=(row+(direction==='east'?1:0))/w
      points=[[x,1-start/h,15/32],[x,1-end/h,15/32],[x,1-end/h,17/32],[x,1-start/h,17/32]]
      normal=[direction==='east'?1:-1,0,0];uv=[row/w*16,start/h*16,(row+1)/w*16,end/h*16]
    }
    front.push({points,normal,uv,texture,rotation:0,shade:true})
  }
  return front
}
