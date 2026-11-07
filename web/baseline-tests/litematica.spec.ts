import { expect, test } from '@playwright/test'

test('litematica preview rotates, slices and handles errors without losing controls', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('mcpanel:auth-token', 'test')
    localStorage.setItem('mcpanel:last-page', 'litematica')
    localStorage.setItem('mcpanel:theme', 'dark')
  })
  const blocks: number[][] = []
  for (let x=0;x<10;x++) for(let z=0;z<8;z++) for(let y=0;y<6;y++) {
    if(y===0 || x===0 || x===9 || z===0 || z===7) blocks.push([x,y,z,y===0?0:1])
  }
  let fail = false
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown = {}
    if(path.endsWith('/bootstrap')) json = {needs_setup:false}
    else if(path.endsWith('/me')) json = {id:1,username:'tester',role:'owner',verified:true}
    else if(path==='/api/litematica') json = [{name:'house.litematic',size_bytes:512,info:{size:[10,6,8],regions:1,total_blocks:blocks.length,materials:[]}}]
    else if(path.endsWith('/info')) json = {size:[10,6,8],regions:1,total_blocks:blocks.length,materials:[{id:'minecraft:stone',count:80},{id:'minecraft:oak_planks',count:blocks.length-80}]}
    else if(path.endsWith('/preview')) {
      if(fail) return route.fulfill({status:400,json:{error:'预览失败'}})
      const layer=url.searchParams.has('layer')?Number(url.searchParams.get('layer')):null
      const selected=layer===null?blocks:blocks.filter(b=>b[1]===layer)
      json={origin:[0,0,0],size:[10,6,8],regions:[{name:'house',origin:[0,0,0],size:[10,6,8]}],palette:['minecraft:stone','minecraft:oak_planks'],blocks:selected,total_blocks:selected.length,sampled:false,layer}
    }
    await route.fulfill({json})
  })
  await page.goto('/')
  await page.getByRole('button',{name:'house.litematic',exact:true}).click()
  const canvas=page.locator('canvas')
  await expect(canvas).toBeVisible()
  await expect(page.getByText('显示当前范围内全部非空气方块。',{exact:false})).toBeVisible()
  await expect(page.getByText('加载方块模型与纹理…', {exact:true})).toHaveCount(0)
  await expect(page.getByText('拖动旋转 · 滚轮缩放 · Java 26.3 模型与贴图')).toBeVisible()
  const colorCount = await canvas.evaluate(el => {
    const context = (el as HTMLCanvasElement).getContext('2d')!
    const pixels = context.getImageData(0, 0, el.width, el.height).data
    const colors = new Set<string>()
    for (let i=0; i<pixels.length; i+=4) if(pixels[i+3]===255) colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`)
    return colors.size
  })
  expect(colorCount).toBeGreaterThan(50)
  const before=await canvas.evaluate(el=>(el as HTMLCanvasElement).toDataURL())
  await page.getByRole('button',{name:'旋转',exact:true}).click()
  await expect.poll(()=>canvas.evaluate(el=>(el as HTMLCanvasElement).toDataURL())).not.toBe(before)
  // Once prepared, rotating must not re-read pixels or rebuild face textures.
  const readbacks = await page.evaluate(async () => {
    let reads = 0
    const original = CanvasRenderingContext2D.prototype.getImageData
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof original>) {
      reads++
      return original.apply(this, args)
    }
    try {
      for (let i=0;i<3;i++) {
        Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='旋转')!.click()
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      }
      return reads
    } finally { CanvasRenderingContext2D.prototype.getImageData = original }
  })
  expect(readbacks).toBe(0)
  await page.screenshot({path:'../logs/litematica-preview.png'})
  await page.getByRole('button',{name:'单层查看',exact:true}).click()
  await expect(page.getByRole('spinbutton',{name:'输入层高'})).toBeVisible()
  await page.getByRole('spinbutton',{name:'输入层高'}).fill('3')
  await expect(page.getByText('当前范围 32 个方块',{exact:false})).toBeVisible()
  fail=true
  await page.getByRole('button',{name:'完整投影',exact:true}).click()
  await expect(page.getByRole('alert').filter({hasText:'预览失败'})).toBeVisible()
  fail=false
  await page.getByRole('button',{name:'重试',exact:true}).click()
  await expect(page.getByRole('alert').filter({hasText:'预览失败'})).toHaveCount(0)
  await page.setViewportSize({width:390,height:844})
  await expect(canvas).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})


test('vanilla models preserve non-cube shapes, facing, multipart and lit textures', async ({ page }) => {
  await page.route('**/model-test', route => route.fulfill({contentType:'text/html',body:'<html><body>Models</body></html>'}))
  await page.goto('/model-test')
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite serves source modules in the browser.
    const { bakePreviewBlock } = await import('/src/lib/special-blocks.ts')
    const assets = await (await fetch('/blocks/models/definitions.json')).json()
    const layers = await (await fetch('/blocks/models/entities.json')).json()
    const bake = (id: string, properties = {}) => bakePreviewBlock(assets, layers, 'minecraft:' + id, properties)
    const slab = bake('oak_slab', {type:'bottom'})
    const top = bake('oak_slab', {type:'top'})
    const rail = bake('rail', {shape:'north_south'})
    const torch = bake('redstone_torch', {lit:'true'})
    const off = bake('redstone_torch', {lit:'false'})
    const wall = bake('redstone_wall_torch', {lit:'true',facing:'east'})
    const wire = bake('redstone_wire', {east:'side',west:'side',north:'none',south:'none',power:'15'})
    const shulker = bake('shulker_box', {facing:'up'})
    const colored = bake('red_shulker_box', {facing:'east'})
    const sign = bake('cherry_sign', {rotation:'8'})
    const diagonal = bake('cherry_sign', {rotation:'1'})
    const wallSign = bake('oak_wall_sign', {facing:'west'})
    const hopper = bake('hopper', {facing:'down',enabled:'true'})
    const observer = bake('observer', {facing:'north',powered:'false'})
    const east = bake('observer', {facing:'east',powered:'false'})
    // JSON normalization keeps the test independent of TypeScript-only model types.
    type Face = { points: number[][]; texture: number; normal: number[]; tint?: string }
    const height = (model: {faces: Face[]}) => model.faces.flatMap(f => f.points.map(p=>p[1]))
    const front = assets.textures['block/observer_front']
    return {
      shulkerFaces:shulker.faces.length, signFaces:sign.faces.length, wallSignFaces:wallSign.faces.length, coloredTexture:shulker.faces[0].texture !== colored.faces[0].texture, signRotates:JSON.stringify(sign.faces[0].points)!==JSON.stringify(diagonal.faces[0].points),
      bottomMax:Math.max(...height(slab)),topMin:Math.min(...height(top)),railMax:Math.max(...height(rail)),
      torchFaces:torch.faces.length,litDifferent:torch.faces[0].texture!==off.faces[0].texture,
      tilted:wall.faces.some((f:Face)=>f.normal.some(n=>Math.abs(n)>0.01 && Math.abs(n)<0.99)),
      wireFaces:wire.faces.length,wireMax:Math.max(...height(wire)),wireTint:wire.faces.some((f:Face)=>!!f.tint),
      north:observer.faces.find((f:Face)=>f.texture===front).normal,
      east:east.faces.find((f:Face)=>f.texture===front).normal,
      unsupported:[slab,top,rail,torch,off,wall,wire,hopper,observer,east,shulker,colored,sign,diagonal,wallSign].some(m=>m.unsupported),
      unknown:bakePreviewBlock(assets,layers,'mod:missing',{}).unsupported,
    }
  })
  expect(result.shulkerFaces).toBe(12)
  expect(result.signFaces).toBe(11)
  expect(result.wallSignFaces).toBe(6)
  expect(result.coloredTexture).toBe(true)
  expect(result.signRotates).toBe(true)
  expect(result.bottomMax).toBe(0.5)
  expect(result.topMin).toBe(0.5)
  expect(result.railMax).toBeLessThan(0.1)
  expect(result.torchFaces).toBe(12)
  expect(result.litDifferent).toBe(true)
  expect(result.tilted).toBe(true)
  expect(result.wireFaces).toBeGreaterThan(0)
  expect(result.wireMax).toBeLessThan(0.1)
  expect(result.wireTint).toBe(true)
  expect(result.north[2]).toBeCloseTo(-1)
  expect(result.east[0]).toBeCloseTo(1)
  expect(result.unsupported).toBe(false)
  expect(result.unknown).toBe(true)
})
