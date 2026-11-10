import { test, expect } from '@playwright/test'

test('server import reads metadata automatically for uploads, URLs and host folders', async ({page})=>{
  const errors:string[]=[]
  const requests:{path:string;body:Record<string,unknown>}[]=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.addInitScript(()=>{
    localStorage.setItem('mcpanel:auth-token','test')
    localStorage.setItem('mcpanel:last-page','servers')
    localStorage.setItem('mcpanel:theme','dark')
  })
  const state={id:'abcd',name:'server.zip',size:3,received:0,status:'uploading',stage:'上传中',processed:0,total:0,message:'',server_id:1,chunk_bytes:4194304}
  await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname
    let json:unknown={}
    if(req.method()==='POST')requests.push({path,body:req.postData()?JSON.parse(req.postData()!):{}})
    if(path.endsWith('/bootstrap'))json={needs_setup:false}
    else if(path.endsWith('/me'))json={id:1,username:'admin',role:'admin',verified:true}
    else if(path==='/api/servers')json=[{id:1,name:'test server',dir_name:'test',server_type:'vanilla',mc_version:'26.3',loader_version:'',min_memory:'1G',max_memory:'2G',port:25565,status:'stopped',auto_start:false,protected:false,startup_commands:[]}]
    else if(path==='/api/groups')json=[]
    else if(path==='/api/uploads/local-directories') {
      const current=url.searchParams.get('path')??''
      json={path:current,parent:current?'':null,directories:current?[]:[{name:'Server files',path:'C:\\servers\\my-server'}]}
    }
    else if(path==='/api/uploads')json=state
    else if(path.endsWith('/chunks'))json={...state,received:3}
    else if(path.endsWith('/import')||path.includes('/uploads/export/'))json={...state,status:'processing',stage:'识别中'}
    else if(path.endsWith('/download-link'))json={url:'/test-export.zip'}
    else if(path.startsWith('/api/uploads/'))json={...state,status:'done',stage:'完成'}
    await route.fulfill({json})
  })
  await page.route('**/test-export.zip',r=>r.fulfill({contentType:'application/zip',headers:{'Content-Disposition':'attachment; filename="test.zip"'},body:'zip'}))
  await page.goto('/')
  const open=async()=>{await page.getByRole('button',{name:'导入服务器',exact:true}).click()}
  await open()
  const dialog=page.getByRole('dialog')
  await expect(dialog.getByLabel('实例名称')).toHaveCount(0)
  await expect(dialog.getByLabel('端口',{exact:true})).toHaveCount(0)
  await dialog.getByLabel('服务器包',{exact:true}).setInputFiles({name:'server.7z',mimeType:'application/x-7z-compressed',buffer:Buffer.from('abc')})
  await dialog.getByRole('button',{name:'导入服务器',exact:true}).click()
  await expect(dialog.getByText('导入完成，可在实例列表查看并启动服务器。')).toBeVisible()
  expect(requests.find(r=>r.path==='/api/uploads')?.body).toEqual({kind:'package',name:'server.7z',size:3})
  await dialog.getByRole('button',{name:'关闭',exact:true}).click()
  await open()
  await dialog.getByRole('button',{name:'下载直链',exact:true}).click()
  await dialog.getByLabel('下载直链',{exact:true}).fill('https://example.test/server.tar.gz')
  await dialog.getByRole('button',{name:'导入服务器',exact:true}).click()
  await expect(dialog.getByText('导入完成，可在实例列表查看并启动服务器。')).toBeVisible()
  expect(requests.filter(r=>r.path.endsWith('/import')).at(-1)?.body).toEqual({source:'url',url:'https://example.test/server.tar.gz'})
  await dialog.getByRole('button',{name:'关闭',exact:true}).click()
  await open()
  await dialog.getByRole('tab',{name:'本地文件夹'}).click()
  await dialog.getByRole('button',{name:'Server files'}).click()
  await expect(dialog.getByLabel('服务器文件夹',{exact:true})).toHaveValue('C:\\servers\\my-server')
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.screenshot({path:'../logs/server-import-mobile.png'})
  await dialog.getByRole('button',{name:'导入服务器',exact:true}).click()
  await expect(dialog.getByText('导入完成，可在实例列表查看并启动服务器。')).toBeVisible()
  expect(requests.filter(r=>r.path.endsWith('/import')).at(-1)?.body).toEqual({source:'local',path:'C:\\servers\\my-server'})
  await dialog.getByRole('button',{name:'关闭',exact:true}).click()
  await page.getByRole('button',{name:'整包导出',exact:true}).click()
  await dialog.getByRole('button',{name:'开始导出'}).click()
  await expect(dialog.getByRole('button',{name:'下载 ZIP'})).toBeVisible()
  const download=page.waitForEvent('download')
  await dialog.getByRole('button',{name:'下载 ZIP'}).click()
  expect((await download).suggestedFilename()).toMatch(/\.zip$/)
  expect(errors).toEqual([])
})
