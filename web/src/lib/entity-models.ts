import { bakeModel, type BakedFace, type BakedModel, type ModelAssets, type Vec3 } from './block-models'
import { array, bakeLayer, chatText, dye, number, object, partTransforms, plane, short, string, transformFaces, type EntityLayers, type Pose, type ModelPart } from './entity-geometry'
import { bakeItem } from './item-models'
import { bakePreviewBlock } from './special-blocks'
import { skinProfile } from './skin-profile'

export interface PreviewEntity {id:string;position:Vec3;rotation:[number,number];data:Record<string,unknown>}
export interface EntityModel extends BakedModel { warnings?:string[] }
// Defaults differ from registry names in the vanilla renderer. Every path is
// validated against the extracted client texture atlas by the coverage test.
const textures:Record<string,string>={
  armor_stand:'armorstand/armorstand',axolotl:'axolotl/axolotl_lucy',polar_bear:'bear/polarbear',
  bogged:'skeleton/bogged',parched:'skeleton/parched',camel_husk:'camel/camel_husk',cat:'cat/cat_tabby',
  cave_spider:'spider/cave_spider',chicken:'chicken/chicken_temperate',cow:'cow/cow_temperate',pig:'pig/pig_temperate',
  cod:'fish/cod',cushion:'cushion/white_cushion',drowned:'zombie/drowned',elder_guardian:'guardian/guardian_elder',
  ender_dragon:'enderdragon/dragon',evoker:'illager/evoker',evoker_fangs:'illager/evoker_fangs',frog:'frog/frog_temperate',
  giant:'zombie/zombie',glow_squid:'squid/glow_squid',happy_ghast:'ghast/happy_ghast',horse:'horse/horse_white',
  donkey:'horse/donkey',mule:'horse/mule',skeleton_horse:'horse/horse_skeleton',zombie_horse:'horse/horse_zombie',
  husk:'zombie/husk',illusioner:'illager/illusioner',leash_knot:'lead_knot/lead_knot',llama:'llama/llama_creamy',
  trader_llama:'llama/llama_creamy',llama_spit:'llama/llama_spit',magma_cube:'slime/magmacube',mooshroom:'cow/mooshroom_red',
  ocelot:'cat/ocelot',parrot:'parrot/parrot_red_blue',piglin_brute:'piglin/piglin_brute',pillager:'illager/pillager',
  pufferfish:'fish/pufferfish',rabbit:'rabbit/rabbit_brown',ravager:'illager/ravager',salmon:'fish/salmon',
  shulker:'shulker/shulker',shulker_bullet:'shulker/spark',stray:'skeleton/stray',sulfur_cube:'sulfur_cube/sulfur_cube_outer',
  tropical_fish:'fish/tropical_a',vex:'illager/vex',vindicator:'illager/vindicator',wither_skeleton:'skeleton/wither_skeleton',
  wither_skull:'wither/wither',zoglin:'hoglin/zoglin',zombie_nautilus:'nautilus/zombie_nautilus',
  zombified_piglin:'piglin/zombified_piglin',player:'player/wide/steve',mannequin:'player/wide/steve',
  arrow:'projectiles/arrow',spectral_arrow:'projectiles/arrow_spectral',wind_charge:'projectiles/wind_charge',breeze_wind_charge:'projectiles/wind_charge',
}
const layerAliases:Record<string,string>={camel_husk:'camel',pufferfish:'pufferfish_small',tropical_fish:'tropical_fish_small',spectral_arrow:'arrow',breeze_wind_charge:'wind_charge',mannequin:'player'}
const invisible=new Set(['marker','interaction','area_effect_cloud'])
const projectileItems:Record<string,string>={snowball:'snowball',egg:'egg',ender_pearl:'ender_pearl',eye_of_ender:'ender_eye',experience_bottle:'experience_bottle',splash_potion:'splash_potion',lingering_potion:'lingering_potion',fireball:'fire_charge',small_fireball:'fire_charge',firework_rocket:'firework_rocket'}
const hangingRotation=(facing:unknown):Vec3=>typeof facing==='string'?({north:[0,180,0],south:[0,0,0],west:[0,-90,0],east:[0,90,0],up:[-90,0,0],down:[90,0,0]} as Record<string,Vec3>)[facing]??[0,0,0]:({0:[90,0,0],1:[-90,0,0],2:[0,180,0],3:[0,0,0],4:[0,-90,0],5:[0,90,0]} as Record<number,Vec3>)[number(facing,3)]??[0,0,0]

export function bakeEntity(assets:ModelAssets,layers:EntityLayers,entity:PreviewEntity):EntityModel {
  const id=short(entity.id),data=entity.data??{},warnings:string[]=[]
  const tex=(key:string)=>assets.textures['entity/'+key]??-1
  const finish=(faces:BakedFace[],unsupported=false):EntityModel=>({faces,unsupported:unsupported||faces.some(f=>f.texture<0&&!f.surface),warnings})
  if(invisible.has(id)||data.Invisible && id!=='armor_stand'&& !id.includes('item_frame'))return finish([])
  if(id==='item_frame'||id==='glow_item_frame') {
    const displayed=object(data.Item??data.item)
    const item=bakeItem(assets,layers,displayed)
    if(short(displayed.id)==='filled_map')warnings.push('地图像素不包含在投影文件中，显示地图物品外观')
    if(item.unsupported)warnings.push('展示框中的物品')
    const frame=data.Invisible?[]:transformFaces(bakeModel(assets,`block/${id}`).faces,{translation:[-.5,-.5,-1]})
    frame.push(...transformFaces(item.faces,{scale:[.5,.5,.5],rotation:[0,0,-number(data.ItemRotation)*45],translation:[0,0,.03]}))
    return finish(transformFaces(frame,{rotation:hangingRotation(data.facing??data.Facing)}),item.unsupported)
  }
  if(id==='painting') {
    const name=short(data.variant??data.Variant,'kebab'),variant=assets.paintings?.[name]
    if(!variant)return finish([],true)
    const texture=assets.textures['painting/'+short(variant.asset_id)]??-1
    return finish(transformFaces(plane(texture,variant.width,variant.height),{rotation:hangingRotation(data.facing??data.Facing)}))
  }
  if(id==='item'||id==='item_display'||id==='ominous_item_spawner'||projectileItems[id]) {
    const result=bakeItem(assets,layers,data.Item??data.item??{id:'minecraft:'+(projectileItems[id]??'air')},id==='item_display'?string(data.item_display,'fixed'):'ground')
    return finish(applyDisplayTransform(result.faces,data,id==='item_display'),result.unsupported)
  }
  if(id==='block_display'||id==='falling_block'||id==='tnt') {
    const state=object(data.block_state??data.BlockState)
    const result=bakePreviewBlock(assets,layers,string(state.Name,'minecraft:'+(id==='tnt'?'tnt':'sand')),object(state.Properties) as Record<string,string>)
    return finish(applyDisplayTransform(result.faces,data,id==='block_display'),result.unsupported)
  }
  if(id==='text_display') {
    const text=chatText(data.text)
    const lines=text.split('\n'),width=Math.min(number(data.line_width,200),Math.max(...lines.map(l=>l.length))*6)/40
    return finish(applyDisplayTransform(plane(-1,Math.max(.1,width),Math.max(.25,lines.length*.25)).map(f=>({...f,surface:{text,color:'#ffffff',background:data.background===0?undefined:'#00000040'}})),data,true))
  }
  if(id==='end_crystal')return finish(transformFaces(bakeLayer(layers,'end_crystal#main',tex('end_crystal/end_crystal'),{base:{hidden:data.ShowBottom===0}}),{scale:[2,2,2],translation:[0,-1,0]}))
  if(id==='lightning_bolt') {
    // Static snapshot of the client's branching, untextured lightning ribbon.
    const faces:BakedFace[]=[]
    for(let i=0;i<8;i++) {
      const x=Math.sin(i*2.4)*.8,z=Math.cos(i*1.7)*.6
      faces.push(...transformFaces(plane(-1,.18,2.15).map(f=>({...f,surface:{color:'#d8cfffcc'}})),{translation:[x,i*2+1,z]}))
      faces.push(...transformFaces(plane(-1,.18,2.15).map(f=>({...f,surface:{color:'#d8cfffcc'}})),{rotation:[0,90,0],translation:[x,i*2+1,z]}))
    }
    return finish(faces)
  }
  if(['dragon_fireball','fishing_bobber','experience_orb'].includes(id)) {
    const key={dragon_fireball:'enderdragon/dragon_fireball',fishing_bobber:'fishing/fishing_hook',experience_orb:'experience/experience_orb'}[id]!
    return finish(plane(tex(key),.5,.5))
  }
  let model=layerAliases[id]??id,texture=textures[id]??`${id}/${id}`,scale=1,baseY=1.5
  const pose:Pose={}
  const baby=number(data.Age)<0||!!data.IsBaby||!!data.Small
  const skin=skinProfile(data.profile??data.SkinData)
  if((id==='player'||id==='mannequin')&&skin.slim)model='player_slim'
  const variant=short(data.variant??data.Variant??data.Type??data.type)
  const boat=/^(.+?)_(chest_)?(boat|raft)$/.exec(id)
  if(boat) {model=`${boat[2]?'chest_boat':'boat'}/${boat[1]}`;texture=model;baseY=.375}
  if(id.endsWith('minecart')) {texture='minecart/minecart';baseY=.375}
  if(['cow','pig','chicken'].includes(id)) {
    const climate=['warm','cold','temperate'].includes(variant)?variant:'temperate'
    texture=`${id}/${id}_${climate}`
    if(layers[`minecraft:${climate}_${id}#main`])model=`${climate}_${id}`
  }
  if(id==='frog')texture=`frog/frog_${variant||'temperate'}`
  if(id==='axolotl')texture='axolotl/axolotl_'+(['lucy','wild','gold','cyan','blue'][number(data.Variant)]??'lucy')
  if(id==='cat')texture='cat/'+({tabby:'cat_tabby',black:'cat_black',red:'cat_red',siamese:'cat_siamese',british_shorthair:'cat_british_shorthair',calico:'cat_calico',persian:'cat_persian',ragdoll:'cat_ragdoll',white:'cat_white',jellie:'cat_jellie',all_black:'cat_all_black'} as Record<string,string>)[variant||'tabby']
  if(id==='wolf') {
    texture='wolf/wolf'+(variant&&variant!=='pale'?'_'+variant:'')+(data.Angry||number(data.AngerTime)>0?'_angry':data.Owner||data.Tame?'_tame':'')
  }
  if(id==='fox')texture='fox/fox'+(variant==='snow'?'_snow':'')+(data.Sleeping?'_sleep':'')
  if(id==='mooshroom')texture='cow/mooshroom_'+(variant==='brown'?'brown':'red')
  if(id==='bee')texture='bee/bee'+(number(data.AngerTime)>0?'_angry':'')+(data.HasNectar?'_nectar':'')
  if(id==='parrot')texture='parrot/parrot_'+(['red_blue','blue','green','yellow_blue','grey'][number(data.Variant)]??'red_blue')
  if(id==='rabbit')texture='rabbit/rabbit_'+({0:'brown',1:'white',2:'black',3:'white_splotched',4:'gold',5:'salt',99:'caerbannog'} as Record<number,string>)[number(data.RabbitType)]
  if(id==='llama'||id==='trader_llama')texture='llama/llama_'+(['creamy','white','brown','gray'][number(data.Variant)]??'creamy')
  if(id==='horse')texture='horse/horse_'+(['white','creamy','chestnut','brown','black','gray','darkbrown'][number(data.Variant)&255]??'white')
  if(id==='pufferfish')model='pufferfish_'+(['small','medium','big'][number(data.PuffState)]??'small')
  if(id==='tropical_fish') {const large=(number(data.Variant)&255)===1;model='tropical_fish_'+(large?'large':'small');texture='fish/tropical_'+(large?'b':'a')}
  if(id==='salmon'&&['small','large'].includes(variant))model='salmon_'+variant
  if(id==='panda'&&data.MainGene&&data.MainGene!=='normal')texture='panda/panda_'+string(data.MainGene)
  if(id==='zombie_nautilus'&&variant==='coral') {texture='nautilus/zombie_nautilus_coral';model='zombie_nautilus_coral'}
  if(id==='strider'&&data.Suffocating)texture='strider/strider_cold'
  if(id==='cushion')texture='cushion/'+string(data.color,'white')+'_cushion'
  if(id==='slime'||id==='magma_cube')scale=number(data.Size)+1
  // Giant/ghast/guardian scales are already baked into 26.3 model roots.
  if(id==='phantom')scale=1+number(data.Size)*.15
  if(id==='copper_golem') {
    const oxidation=short(data.weather_state??data.Oxidation)
    if(['exposed','weathered','oxidized'].includes(oxidation))texture+='_'+oxidation
  }
  const variantDefinition=assets.variants?.[id]?.[variant]
  if(variantDefinition) {
    const state=data.Angry||number(data.AngerTime)>0?'angry':data.Owner||data.Tame?'tame':'wild'
    const path=baby?variantDefinition.baby_asset_id??variantDefinition.baby_assets?.[state]:variantDefinition.asset_id??variantDefinition.assets?.[state]
    if(path)texture=short(path).replace(/^entity\//,'')
  }
  if(id==='armor_stand') {
    if(baby)model='armor_stand_small'
    const values=object(data.Pose??data.pose)
    const defaults:Record<string,number[]>={Head:[0,0,0],Body:[0,0,0],LeftArm:[-10,0,-10],RightArm:[-15,0,10],LeftLeg:[-1,0,-1],RightLeg:[1,0,1]}
    for(const [tag,name] of Object.entries({Head:'head',Body:'body',LeftArm:'left_arm',RightArm:'right_arm',LeftLeg:'left_leg',RightLeg:'right_leg'})) {
      const v=array(values[tag]).length?array(values[tag]):defaults[tag]
      pose[name]={xRot:number(v[0])*Math.PI/180,yRot:number(v[1])*Math.PI/180,zRot:number(v[2])*Math.PI/180}
    }
    pose.left_arm.hidden=!data.ShowArms;pose.right_arm.hidden=!data.ShowArms
    pose.base_plate={hidden:!!data.NoBasePlate}
  } else if(baby) {
    if(layers[`minecraft:${model}_baby#main`])model+='_baby'
    else scale*=.5
    if(tex(texture+'_baby')>=0)texture+='_baby'
    if(id==='sniffer')texture='sniffer/snifflet'
  }
  if(id==='goat') {pose.left_horn={hidden:data.HasLeftHorn===0};pose.right_horn={hidden:data.HasRightHorn===0}}
  const stance=id==='fox'&&data.Sleeping?'sleeping':data.Sitting?'sitting':'main'
  const key=model+'#'+(layers[`minecraft:${model}#${stance}`]?stance:'main')
  if(!layers['minecraft:'+key])return finish([],true)
  if(!key.endsWith('#main')) {
    const collect=(part:ModelPart,name:string)=>{
      const {x,y,z,xRot,yRot,zRot,xScale,yScale,zScale,visible}=part
      pose[name]={x,y,z,xRot,yRot,zRot,xScale,yScale,zScale,visible}
      for(const [child,p] of Object.entries(part.children))collect(p,child)
    }
    collect(layers['minecraft:'+key],'root')
  }
  let faces=data.Invisible?[]:bakeLayer(layers,key,tex(texture),pose)
  if((id==='player'||id==='mannequin')&&skin.hash)faces=faces.map(f=>({...f,skin:skin.hash}))
  if(id==='tropical_fish')faces=faces.map(f=>({...f,tint:dye((number(data.Variant)>>16)&255)}))
  const overlay=(layerKey:string,textureKey:string,color?:string)=>{
    const extra=bakeLayer(layers,layerKey,tex(textureKey),pose)
    faces.push(...(color?extra.map(f=>({...f,tint:color})):extra))
  }
  if(id==='sheep'&&!data.Sheared)overlay(`${model}#wool`,`sheep/sheep_wool${baby?'_baby':''}`,dye(data.Color))
  if(id==='tropical_fish')overlay(`${model}#pattern`,`${texture}_pattern_${Math.min(5,(number(data.Variant)>>8)&255)+1}`,dye((number(data.Variant)>>24)&255))
  if(id==='slime')overlay('slime#outer','slime/slime')
  if(id==='drowned')overlay(`${model}#outer`,`zombie/drowned_outer_layer${baby?'_baby':''}`)
  if(id==='stray'||id==='bogged')overlay(`${id}#outer`,`skeleton/${id}_overlay`)
  if(id==='breeze') {overlay('breeze#wind','breeze/breeze_wind');overlay('breeze#eyes','breeze/breeze_eyes')}
  if(id==='creaking')overlay('creaking#eyes','creaking/creaking_eyes')
  if(id==='warden')overlay('warden#bioluminescent','warden/warden_bioluminescent_layer')
  if(id==='sulfur_cube')overlay('sulfur_cube#inner','sulfur_cube/sulfur_cube_inner')
  if(id==='horse') {
    const markings=['','horse_markings_white','horse_markings_whitefield','horse_markings_whitedots','horse_markings_blackdots'][(number(data.Variant)>>8)&255]
    if(markings)overlay(key,`horse/${markings}`)
  }
  if(id==='villager'||id==='zombie_villager') {
    const info=object(data.VillagerData)
    overlay(key,`${id}/${baby?'baby':'type'}/${short(info.type,'plains')}`)
    const profession=short(info.profession,'none')
    if(profession!=='none')overlay(key,`${id}/profession/${profession}`)
  }
  const equipment=object(data.equipment),armor=array(data.ArmorItems),hands=array(data.HandItems)
  if((id==='wolf'||id==='cat')&&(data.Owner||data.Tame))overlay(id==='cat'?`${model}#collar`:key,`${id}/${id}_collar${baby?'_baby':''}`,dye(data.CollarColor??data.collar_color??14))
  const bodyItem=object(equipment.body??data.body_armor_item??data.ArmorItem??data.DecorItem)
  const bodyId=short(bodyItem.id)
  const bodyType=id.includes('horse')?'horse_body':id==='wolf'?'wolf_body':id.includes('llama')?'llama_body':id.includes('nautilus')?'nautilus_body':id==='happy_ghast'?'happy_ghast_body':''
  const bodyAsset=bodyId==='wolf_armor'?'armadillo_scute':bodyId.replace(/_(horse|nautilus)_armor$/,'').replace(/^golden$/,'gold')||(id==='trader_llama'?(baby?'trader_llama_baby':'trader_llama'):'')
  const bodyLayer=id.includes('horse')?(id==='horse'?'horse_armor':'undead_horse_armor')+'#main':id==='wolf'?'wolf_armor#main':id.includes('llama')?`${baby?'llama_baby':'llama'}#decor`:id.includes('nautilus')?'nautilus_armor#main':id==='happy_ghast'?`${baby?'happy_ghast_baby':'happy_ghast'}_harness#main`:''
  for(const entry of assets.equipment?.[bodyAsset]?.layers[bodyType]??[]) {
    const color=entry.dyeable?'#'+(number(object(object(bodyItem.components)['minecraft:dyed_color']).rgb??object(bodyItem.components)['minecraft:dyed_color'],0xa06540)&0xffffff).toString(16).padStart(6,'0'):undefined
    overlay(bodyLayer,`equipment/${bodyType}/${short(entry.texture)}`,color)
  }
  if(data.Saddle||object(equipment.saddle??data.saddle??data.SaddleItem).id) {
    const saddleType=id+'_saddle',saddleLayer=layers[`minecraft:${model}#saddle`]?model:id
    for(const entry of assets.equipment?.saddle?.layers[saddleType]??[])overlay(`${saddleLayer}#saddle`,`equipment/${saddleType}/${short(entry.texture)}`)
  }
  const slots=['feet','legs','chest','head']
  for(const [i,slot] of slots.entries()) {
    const item=object(equipment[slot]??armor[i]),itemId=short(item.id)
    if(!itemId||itemId==='air')continue
    if(itemId==='elytra'&&slot==='chest') {
      overlay(`${baby?'elytra_baby':'elytra'}#main`,'equipment/wings/elytra')
      continue
    }
    const suffix=['boots','leggings','chestplate','helmet'][i]
    const material=itemId.replace('_'+suffix,'')
    const equipmentId=material==='golden'?'gold':material==='chainmail'?'chainmail':material==='turtle'?'turtle_scute':material
    const equipmentType=i===1?'humanoid_leggings':baby&&assets.equipment?.[equipmentId]?.layers.humanoid_baby?'humanoid_baby':'humanoid'
    const textureLayers=assets.equipment?.[equipmentId]?.layers[equipmentType]
    if(textureLayers&&layers[`minecraft:${model}#${suffix}`]) {
      const allowed=i===3?['head','hat']:i===2?['body','left_arm','right_arm']:i===1?['body','left_leg','right_leg']:['left_leg','right_leg']
      const armorPose:Pose={...pose}
      for(const child of Object.keys(layers[`minecraft:${model}#${suffix}`].children))armorPose[child]={...pose[child],hidden:!allowed.includes(child)}
      for(const entry of textureLayers) {
        const path='entity/equipment/'+equipmentType+'/'+short(entry.texture)
        let gear=bakeLayer(layers,`${model}#${suffix}`,assets.textures[path]??-1,armorPose)
        if(entry.dyeable) {
          const components=object(item.components),rgb=object(components['minecraft:dyed_color']).rgb??components['minecraft:dyed_color']??object(object(item.tag).display).color
          const color='#'+number(rgb,0xa06540).toString(16).padStart(6,'0')
          gear=gear.map(f=>({...f,tint:color}))
        }
        faces.push(...gear)
      }
      const trim=object(object(item.components)['minecraft:trim'])
      if(trim.pattern&&trim.material) {
        const material=short(trim.material),darker=material===equipmentId?'_darker':''
        const path=`trims/entity/${equipmentType}/${short(trim.pattern)}_${material}${darker}`
        const index=assets.textures[path]
        if(index!==undefined)faces.push(...bakeLayer(layers,`${model}#${suffix}`,index,armorPose))
        else warnings.push('盔甲纹饰')
      }
    } else if(slot==='head') {
      const result=bakeItem(assets,layers,item,'head')
      let gear=transformFaces(result.faces,{translation:[0,-.5,0]})
      for(const t of partTransforms(layers,key,'head',pose))gear=transformFaces(gear,t)
      faces.push(...gear)
      if(result.unsupported)warnings.push('头部装备')
    } else warnings.push('装备 '+itemId)
  }
  for(const [i,side] of ['right','left'].entries()) {
    const raw=equipment[i?'offhand':'mainhand']??hands[i]
    if(!object(raw).id)continue
    const result=bakeItem(assets,layers,raw,'thirdperson_'+(i?'lefthand':'righthand'))
    let held=transformFaces(result.faces,{rotation:[-90,180,0],translation:[0,.625,0]})
    for(const t of partTransforms(layers,key,side+'_arm',pose))held=transformFaces(held,t)
    faces.push(...held)
    if(result.unsupported)warnings.push('手持物品')
  }
  if(id==='enderman'&&data.CarriedBlockState) {
    const state=object(data.CarriedBlockState),held=bakePreviewBlock(assets,layers,string(state.Name),object(state.Properties) as Record<string,string>)
    faces.push(...transformFaces(held.faces,{scale:[.5,-.5,-.5],translation:[-.25,.5,-.5]}))
  }
  if(id==='snow_golem'&&data.Pumpkin!==0)faces.push(...transformFaces(bakePreviewBlock(assets,layers,'minecraft:carved_pumpkin').faces,{scale:[.625,-.625,-.625],translation:[-.3125,0,.3125]}))
  if(id.endsWith('minecart')&&id!=='minecart') {
    const block={chest_minecart:'chest',furnace_minecart:'furnace',hopper_minecart:'hopper',tnt_minecart:'tnt',spawner_minecart:'spawner',command_block_minecart:'command_block'}[id]
    if(block)faces.push(...transformFaces(bakePreviewBlock(assets,layers,'minecraft:'+block).faces,{scale:[.75,-.75,-.75],translation:[-.375,0,.375]}))
  }
  if(id==='armor_stand'&&data.Invisible)faces=faces.filter(f=>f.texture!==tex(texture))
  faces=transformFaces(faces,{scale:[scale,-scale,-scale],translation:[0,baseY*scale,0]})
  faces=transformFaces(faces,{rotation:[0,-number(entity.rotation?.[0]),0]})
  return finish(faces,warnings.length>0)
}

function applyDisplayTransform(faces:BakedFace[],data:Record<string,unknown>,display:boolean):BakedFace[] {
  if(!display)return faces
  const matrix=array(data.transformation).map(v=>number(v))
  if(matrix.length===16) {
    const transform=(p:Vec3):Vec3=>[0,1,2].map(i=>p[0]*matrix[i]+p[1]*matrix[i+4]+p[2]*matrix[i+8]+matrix[i+12]) as Vec3
    const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
    const a=matrix.slice(0,3) as Vec3,b=matrix.slice(4,7) as Vec3,c=matrix.slice(8,11) as Vec3
    const co=[cross(b,c),cross(c,a),cross(a,b)],det=a.reduce((sum,n,i)=>sum+n*co[0][i],0)
    const normal=(p:Vec3):Vec3=>{
      const n=[0,1,2].map(i=>(co[0][i]*p[0]+co[1][i]*p[1]+co[2][i]*p[2])/(det||1)) as Vec3
      const length=Math.hypot(...n)||1
      return n.map(v=>v/length) as Vec3
    }
    return faces.map(f=>({...f,points:f.points.map(transform),normal:normal(f.normal)}))
  }
  const t=object(data.transformation)
  const vector=(v:unknown,fallback:Vec3):Vec3=>array(v).length===3?array(v).map(n=>number(n)) as Vec3:fallback
  const rotateQuaternion=(faces:BakedFace[],raw:unknown)=>{
    const q=array(raw)
    if(q.length!==4)return faces
    const [x,y,z,w]=q.map(v=>number(v)),length=Math.hypot(x,y,z,w)
    if(!length)return faces
    const rotate=(p:Vec3):Vec3=>{
      const qx=x/length,qy=y/length,qz=z/length,qw=w/length
      const tx=2*(qy*p[2]-qz*p[1]),ty=2*(qz*p[0]-qx*p[2]),tz=2*(qx*p[1]-qy*p[0])
      return [p[0]+qw*tx+qy*tz-qz*ty,p[1]+qw*ty+qz*tx-qx*tz,p[2]+qw*tz+qx*ty-qy*tx]
    }
    return faces.map(f=>({...f,points:f.points.map(rotate),normal:rotate(f.normal)}))
  }
  faces=rotateQuaternion(faces,t.right_rotation)
  faces=transformFaces(faces,{scale:vector(t.scale,[1,1,1])})
  faces=rotateQuaternion(faces,t.left_rotation)
  return transformFaces(faces,{translation:vector(t.translation,[0,0,0])})
}
