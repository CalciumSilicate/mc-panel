import { test, expect } from '@playwright/test'

test('Java 26.3 registry geometry and saved entity appearances', async ({page})=>{
  await page.route('**/model-test',route=>route.fulfill({contentType:'text/html',body:'<html><body>Model coverage</body></html>'}))
  await page.goto('/model-test')
  const result=await page.evaluate(async()=>{
    // @ts-expect-error Vite serves source modules in the browser.
    const {bakePreviewBlock}=await import('/src/lib/special-blocks.ts')
    // @ts-expect-error Vite serves source modules in the browser.
    const {bakeEntity}=await import('/src/lib/entity-models.ts')
    // @ts-expect-error Vite serves source modules in the browser.
    const {bakeItem}=await import('/src/lib/item-models.ts')
    const [assets,layers,input]=await Promise.all(['definitions','entities','coverage-input'].map(name=>fetch('/blocks/models/'+name+'.json').then(r=>r.json())))
    type Face={points:number[][];normal:number[];texture:number;surface?:unknown;tint?:string}
    type Model={faces:Face[];unsupported:boolean}
    const failures:string[]=[],invalid:string[]=[]
    const check=(label:string,model:Model)=>{
      if(model.unsupported)failures.push(label)
      if(!model.faces.every(f=>[...f.points.flat(),...f.normal].every(Number.isFinite)))invalid.push(label)
    }
    let states=0
    for(const [id,value] of Object.entries(input.blocks))for(const state of (value as {states:{properties:Record<string,string>}[]}).states) {
      const data=id==='minecraft:moving_piston'?{blockState:{Name:'minecraft:stone'},progress:.5,extending:true}:{}
      check(id,bakePreviewBlock(assets,layers,id,state.properties,data));states++
    }
    const entity=(id:string,data={},rotation=[0,0]):Model=>bakeEntity(assets,layers,{id:'minecraft:'+id,position:[0,0,0],rotation,data})
    for(const id of input.entities)check(id,entity(id.replace('minecraft:','')))
    for(const id of Object.keys(assets.items))check(id,bakeItem(assets,layers,{id:'minecraft:'+id}))
    for(const [id,variants] of Object.entries(assets.variants))for(const variant of Object.keys(variants as object))for(const baby of [false,true])check(`${id}/${variant}/${baby}`,entity(id,{variant:'minecraft:'+variant,Age:baby?-100:0}))
    const regular=entity('armor_stand',{ShowArms:1})
    const posed=entity('armor_stand',{ShowArms:1,Pose:{RightArm:[-90,0,0]}})
    const gear=entity('armor_stand',{ShowArms:1,equipment:{head:{id:'minecraft:diamond_helmet',components:{'minecraft:trim':{material:'minecraft:gold',pattern:'minecraft:sentry'}}},chest:{id:'minecraft:diamond_chestplate'},mainhand:{id:'minecraft:diamond_sword'}}})
    check('armor equipment',gear)
    const north=entity('item_frame',{Facing:2,Item:{id:'minecraft:diamond_sword'},ItemRotation:0})
    const east=entity('item_frame',{Facing:5,Item:{id:'minecraft:diamond_sword'},ItemRotation:1})
    check('item frame',north);check('rotated item frame',east)
    const banner=bakePreviewBlock(assets,layers,'minecraft:red_banner',{}, {patterns:[{pattern:'minecraft:creeper',color:'yellow'}]})
    const sign=bakePreviewBlock(assets,layers,'minecraft:oak_sign',{}, {front_text:{messages:['{"text":"你好"}','','',''],color:'black'}})
    check('banner',banner);check('sign',sign)
    const baby=entity('cow',{Age:-100}),adult=entity('cow')
    const size=(m:Model,axis:number)=>Math.max(...m.faces.flatMap(f=>f.points.map(p=>p[axis])))-Math.min(...m.faces.flatMap(f=>f.points.map(p=>p[axis])))
    const dye=entity('sheep',{Color:14}),shorn=entity('sheep',{Sheared:1})
    const sword=bakeItem(assets,layers,{id:'minecraft:diamond_sword'})
    return {version:assets.version,states,failures,invalid,poseChanges:JSON.stringify(regular)!==JSON.stringify(posed),gearAdds:gear.faces.length>regular.faces.length,frameChanges:JSON.stringify(north)!==JSON.stringify(east),babySmaller:size(baby,1)<size(adult,1),bannerTint:banner.faces.some((f:Face)=>!!f.tint),signText:sign.faces.some((f:Face)=>!!f.surface),wool:dye.faces.length>shorn.faces.length,swordExtruded:size(sword,2)>0,swordFaces:sword.faces.length,ghastWidth:size(entity('ghast'),0),giantHeight:size(entity('giant'),1)}
  })
  expect(result.version).toBe('26.3')
  expect(result.states).toBe(35723)
  expect(result.failures).toEqual([])
  expect(result.invalid).toEqual([])
  expect(result.poseChanges).toBe(true)
  expect(result.gearAdds).toBe(true)
  expect(result.frameChanges).toBe(true)
  expect(result.babySmaller).toBe(true)
  expect(result.bannerTint).toBe(true)
  expect(result.signText).toBe(true)
  expect(result.wool).toBe(true)
  expect(result.swordExtruded).toBe(true)
  expect(result.swordFaces).toBeGreaterThan(2)
  expect(result.ghastWidth).toBeCloseTo(4.5,1)
  expect(result.giantHeight).toBeLessThan(15)
})
