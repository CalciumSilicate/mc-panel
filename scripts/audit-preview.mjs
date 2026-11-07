// Run against the local Vite server: node scripts/audit-preview.mjs [origin]
import { chromium } from '../web/node_modules/@playwright/test/index.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
const browser=await chromium.launch({headless:true})
try {
  const page=await browser.newPage()
  await page.route('**/preview-audit',route=>route.fulfill({contentType:'text/html',body:'<html><body>Preview asset audit</body></html>'}))
  await page.goto((process.argv[2]??'http://localhost:5278')+'/preview-audit')
  const result=await page.evaluate(async()=>{
    const [{bakePreviewBlock},{bakeEntity},{bakeItem},assets,layers,input]=await Promise.all([
      import('/src/lib/special-blocks.ts'),import('/src/lib/entity-models.ts'),import('/src/lib/item-models.ts'),
      fetch('/blocks/models/definitions.json').then(r=>r.json()),fetch('/blocks/models/entities.json').then(r=>r.json()),fetch('/blocks/models/coverage-input.json').then(r=>r.json())
    ])
    const blocks={},entities={},items={},invalid=[]
    let states=0
    const valid=m=>m.faces.every(f=>f.points.flat().every(Number.isFinite)&&f.normal.every(Number.isFinite)&&f.uv.every(Number.isFinite))
    for(const [id,block] of Object.entries(input.blocks))for(const state of block.states) {
      states++
      const data=id==='minecraft:moving_piston'?{blockState:{Name:'minecraft:stone'},progress:.5,extending:true}:{}
      const m=bakePreviewBlock(assets,layers,id,state.properties,data)
      if(m.unsupported)blocks[id]=(blocks[id]??0)+1
      if(!valid(m))invalid.push(id+':'+state.id)
    }
    for(const id of input.entities) {
      const m=bakeEntity(assets,layers,{id,position:[0,0,0],rotation:[0,0],data:{}})
      if(m.unsupported)entities[id]={faces:m.faces.length,missingTextures:m.faces.filter(f=>f.texture<0).length,warnings:m.warnings}
      if(!valid(m))invalid.push(id)
    }
    for(const id of Object.keys(assets.items)) {
      const m=bakeItem(assets,layers,{id:'minecraft:'+id})
      if(m.unsupported)items[id]={faces:m.faces.length,missingTextures:m.faces.filter(f=>f.texture<0).length}
      if(!valid(m))invalid.push(id)
    }
    return {version:assets.version,scope:'Static vanilla geometry and default appearances; moving pistons require saved block-entity data. Not a certification of game-renderer parity.',blockTypes:Object.keys(input.blocks).length,states,entityTypes:input.entities.length,itemTypes:Object.keys(assets.items).length,blocks,entities,items,invalid}
  })
  await mkdir('logs',{recursive:true})
  await writeFile('logs/preview-coverage.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify(result,null,2))
} finally {await browser.close()}
