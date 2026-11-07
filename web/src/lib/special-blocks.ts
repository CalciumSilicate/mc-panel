import { bakeBlock, bakeModel, type BakedModel, type BakedFace, type ModelAssets, type Vec3 } from './block-models'
import { bakeLayer, chatText, transformFaces, dye, number, string, short, array, object, type EntityLayers } from './entity-geometry'
import { skinProfile } from './skin-profile'

const invisible=new Set(['air','cave_air','void_air','barrier','structure_void','light','bubble_column'])
const yaw:Record<string,number>={south:0,west:-90,north:180,east:90}
const tint=(faces:BakedFace[],color:string)=>faces.map(f=>({...f,tint:color}))
const finished=(faces:BakedFace[]):BakedModel=>({faces,unsupported:!faces.length || faces.some(f=>f.texture<0)})

export function bakePreviewBlock(assets:ModelAssets,layers:EntityLayers,id:string,properties:Record<string,string>={},data:Record<string,unknown>={},depth=0):BakedModel {
  const name=short(id), props={...assets.defaults?.[name],...properties}
  const texture=(key:string)=>assets.textures[key]??-1
  const layer=(key:string,tex:string)=>bakeLayer(layers,key,texture(tex))
  const turn=(faces:BakedFace[],angle=yaw[props.facing]??0)=>transformFaces(transformFaces(faces,{translation:[-.5,0,-.5]}),{rotation:[0,angle,0],translation:[.5,0,.5]})
  if(invisible.has(name))return {faces:[],unsupported:false}
  if(name.endsWith('chest')) {
    let tex=name==='ender_chest'?'ender':name==='trapped_chest'?'trapped':'normal'
    if(name.includes('copper'))tex='copper'+(['exposed','weathered','oxidized'].find(s=>name.includes(s))?'_'+['exposed','weathered','oxidized'].find(s=>name.includes(s)):'')
    const half=props.type==='left'?'left':props.type==='right'?'right':''
    return finished(turn(layer(half?`double_chest_${half}#main`:'chest#main',`entity/chest/${tex}${half?'_'+half:''}`)))
  }
  if(name.endsWith('shulker_box')) {
    const color=name==='shulker_box'?'':name.slice(0,-12)
    let faces=transformFaces(layer('shulker_box#main',`entity/shulker/shulker${color?'_'+color:''}`),{scale:[1,-1,-1],translation:[.5,1.5,.5]})
    const angles:Record<string,Vec3>={up:[0,0,0],down:[180,0,0],north:[-90,0,0],south:[90,0,0],east:[0,0,-90],west:[0,0,90]}
    faces=transformFaces(transformFaces(faces,{translation:[-.5,-.5,-.5]}),{rotation:angles[props.facing]??[0,0,0],translation:[.5,.5,.5]})
    return finished(faces)
  }
  if((name.endsWith('_head')||name.endsWith('_skull')) && name!=='piston_head') {
    const kind=name.replace('_wall','')
    const textures:Record<string,string>={skeleton_skull:'skeleton/skeleton',wither_skeleton_skull:'skeleton/wither_skeleton',zombie_head:'zombie/zombie',creeper_head:'creeper/creeper',dragon_head:'enderdragon/dragon',piglin_head:'piglin/piglin',player_head:'player/wide/steve'}
    const key=kind==='dragon_head'?'dragon_skull':kind
    const wall=name.includes('_wall_')
    let faces=transformFaces(layer(`${key}#main`,`entity/${textures[kind]}`),{scale:[-1,-1,1]})
    if(kind==='player_head') {
      const skin=skinProfile(data.profile??data.SkullOwner)
      if(skin.hash)faces=faces.map(f=>({...f,skin:skin.hash}))
    }
    const direction:Vec3=({north:[0,0,-1],south:[0,0,1],west:[-1,0,0],east:[1,0,0]} as Record<string,Vec3>)[props.facing]??[0,0,0]
    faces=transformFaces(faces,{rotation:[0,wall?(yaw[props.facing]??0)+180:number(Number(props.rotation))*-22.5,0],translation:[.5-direction[0]*.25,wall?.25:0,.5-direction[2]*.25]})
    return finished(faces)
  }
  if(name.endsWith('_banner')) {
    const wall=name.includes('_wall_'), key=wall?'wall_banner':'standing_banner'
    const color=name.replace('_wall','').replace('_banner','')
    let faces=layer(`${key}#main`,'entity/banner/banner_base')
    faces.push(...tint(layer(`${key}#flag`,'entity/banner/base'),dye(color)))
    const oldNames:Record<string,string>={bs:'stripe_bottom',ts:'stripe_top',ls:'stripe_left',rs:'stripe_right',cs:'stripe_center',ms:'stripe_middle',ss:'small_stripes',cr:'cross',sc:'straight_cross',bo:'border',cbo:'curly_border',gra:'gradient',gru:'gradient_up',bri:'bricks',cre:'creeper',sku:'skull',flo:'flower',moj:'mojang',glb:'globe',pig:'piglin'}
    for(const [index,p] of array(data.patterns??data.Patterns).slice(0,16).entries()) {
      const pattern=object(p),name=short(pattern.pattern??pattern.Pattern)
      const part=layer(`${key}#flag`,`entity/banner/${oldNames[name]??name}`)
      faces.push(...transformFaces(tint(part,dye(pattern.color??pattern.Color)),{scale:[1+index*.0001,1,1.001+index*.001]}))
    }
    faces=transformFaces(faces,{scale:[2/3,-2/3,-2/3],translation:[.5,0,.5]})
    return finished(turn(faces,wall?(yaw[props.facing]??0):number(Number(props.rotation))*-22.5))
  }
  if(name==='decorated_pot') {
    const faces=layer('decorated_pot_base#main','entity/decorated_pot/decorated_pot_base')
    const sherds=array(data.sherds)
    const sides=['back','left','right','front']
    faces.push(...bakeLayer(layers,'decorated_pot_sides#main',part=>{
      const sherd=short(sherds[sides.indexOf(part)])
      return texture(`entity/decorated_pot/${sherd.endsWith('_pottery_sherd')?sherd.replace('_sherd','_pattern'):'decorated_pot_side'}`)
    }))
    return finished(turn(faces,180+(yaw[props.facing]??0)))
  }
  if(name.includes('copper_golem_statue')) {
    const oxidation=['exposed','weathered','oxidized'].find(s=>name.includes(s))
    const pose=props.copper_golem_pose??'standing'
    const key=pose==='standing'?'copper_golem':`copper_golem_${pose}`
    return finished(turn(transformFaces(layer(`${key}#main`,`entity/copper_golem/copper_golem${oxidation?'_'+oxidation:''}`),{scale:[-1,-1,1],translation:[.5,pose==='standing'?1.5:0,.5]})))
  }
  if(name==='conduit')return finished(transformFaces(layer('conduit#shell','entity/conduit/base'),{translation:[.5,.5,.5]}))
  if(name==='water'||name==='lava') {
    const height=Number(props.level)>=8?1:1-(Number(props.level||0)+1)/9
    const base=bakeModel({...assets,models:{...assets.models,__fluid:{elements:[{from:[0,0,0],to:[16,height*16,16],faces:Object.fromEntries(['up','down','north','south','east','west'].map(d=>[d,{texture:`block/${name}_still`,uv:[0,0,16,16]}]))}]}}},'__fluid')
    return {faces:name==='water'?tint(base.faces,'#3f76e4').map(f=>({...f,opacity:.65})):base.faces,unsupported:base.unsupported}
  }
  if(name==='end_portal'||name==='end_gateway') {
    const height=name==='end_portal'?.75:1
    return bakeModel({...assets,models:{...assets.models,__portal:{elements:[{from:[0,height===1?0:height*16,0],to:[16,height*16,16],faces:Object.fromEntries((height===1?['up','down','north','south','east','west']:['up']).map(d=>[d,{texture:'entity/end_portal/end_portal',uv:[0,0,16,16]}]))}]}}},'__portal')
  }
  if(name==='moving_piston'&&depth<2) {
    const state=object(data.blockState??data.block_state)
    if(state.Name) {
      const model=bakePreviewBlock(assets,layers,string(state.Name),object(state.Properties) as Record<string,string>,{},depth+1)
      const offset=(data.extending?1:-1)*(Math.max(0,Math.min(1,number(data.progress)))-1)
      const direction:Vec3=({north:[0,0,-1],south:[0,0,1],west:[-1,0,0],east:[1,0,0],up:[0,1,0],down:[0,-1,0]} as Record<string,Vec3>)[props.facing]??[0,0,0]
      return {...model,faces:transformFaces(model.faces,{translation:direction.map(n=>n*offset) as Vec3})}
    }
    return {faces:[],unsupported:true}
  }
  if(name==='pitcher_crop'&&props.half==='upper'&&Number(props.age)<3)return {faces:[],unsupported:false}
  const model=bakeBlock(assets,id,props)
  if(name.endsWith('_sign')) {
    const area=(face:BakedFace)=>Math.hypot(...face.points[1].map((n,i)=>n-face.points[0][i]))*Math.hypot(...face.points[3].map((n,i)=>n-face.points[0][i]))
    const boards=model.faces.filter(f=>Math.abs(f.normal[1])<.01).sort((a,b)=>area(b)-area(a)).slice(0,2)
    const angle=(props.rotation?Number(props.rotation)*-22.5:yaw[props.facing]??0)*Math.PI/180
    for(const f of boards) {
      const front=f.normal[0]*Math.sin(angle)+f.normal[2]*Math.cos(angle)>0
      const side=object(data[front?'front_text':'back_text'])
      const lines=array(side.messages).length?array(side.messages):front?[data.Text1,data.Text2,data.Text3,data.Text4]:[]
      const text=lines.map(line=>chatText(line)).join('\n')
      if(!text.trim())continue
      const center=f.points.reduce<number[]>((sum,p)=>sum.map((v,i)=>v+p[i]/4),[0,0,0])
      const points=f.points.map(p=>p.map((n,i)=>center[i]+(n-center[i])*.9+f.normal[i]*.002) as Vec3)
      const color=string(side.color??data.TextColor,'black')
      model.faces.push({...f,points,texture:-1,cull:undefined,shade:false,surface:{text,color:color==='black'?'#171717':dye(color),glow:!!(side.has_glowing_text??data.GlowingText)}})
    }
  }
  return model
}
