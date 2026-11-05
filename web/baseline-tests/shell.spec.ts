import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
const root = process.cwd()
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8'))
const profile = JSON.parse(fs.readFileSync(path.join(root, 'baseline.profile.json'), 'utf8'))
const harness = path.join(root, 'baseline-tests/.runtime-harness.tsx')
test.beforeAll(() => {
  if (fs.existsSync(harness)) throw new Error('Refusing to overwrite an existing browser harness')
  fs.writeFileSync(harness, `import { useState } from 'react'
import { LayoutDashboard } from 'lucide-react'
import Shell from '@/pages/${profile.shell}'
import { EnumSelect } from '@/components/ui/enum-select'
import { MultiSelect } from '@/components/ui/multi-select'
import { ResourceTable } from '@/components/layout/ResourceTable'
${profile.authProvider ? "import { AuthProvider } from '@/components/auth'" : ''}
function Controls() {
 const [value,setValue]=useState(''),[values,setValues]=useState(['custom'])
 return <div className="max-w-xl p-6"><form id="baseline-form"><EnumSelect name="status" aria-label="状态" required value={value} onValueChange={setValue}><option value="">请选择状态</option><option value="active">正常</option></EnumSelect></form>
 <MultiSelect aria-label="自定义筛选" options={[]} allowCustom={value=>/^[a-z-]+$/.test(value)} value={values} onValueChange={setValues}/>
 <ResourceTable rows={[{id:'sample'}]} columns={[{id:'id',label:'ID',value:row=>row.id}]} rowId={row=>row.id} storageKey="baseline-check" columnVersion={1} selectionScope="test" onDelete={async()=>{throw new Error('受控删除失败')}} /></div>
}
export default function Harness() {
 const [page,setPage]=useState('overview'),[out,setOut]=useState(false)
 const user={id:1,username:'baseline',email:'baseline@example.test',role:'${profile.authProvider ? 'owner' : 'admin'}',verified:true,effective_permissions:{download:true,feed:true,logs:true,library:true,telegram:true,settings:true,users:true},permissions:{}}
 const props={onLogout:()=>setOut(true),onUserChange:()=>{},onRefreshUser:()=>{},user,email:user.email,initialPage:'status',siteName:'Baseline',navItems:[{key:'overview',label:'概览',icon:LayoutDashboard},{key:'settings',label:'设置',icon:LayoutDashboard}],currentPage:page,setCurrentPage:setPage}
 if(new URLSearchParams(location.search).has('controls'))return <Controls/>
 if(out)return <h1>本地会话已退出</h1>
 return ${profile.authProvider ? '<AuthProvider initialUser={user}>' : '<>'}<Shell {...props}>${profile.children ? '<h1>{page}</h1>' : ''}</Shell>${profile.authProvider ? '</AuthProvider>' : '</>'}
}`)
})
test.afterAll(() => { if (fs.existsSync(harness)) fs.unlinkSync(harness) })

test('HTTP keeps Headers and multipart contracts, rejects HTML and accepts 204', async ({ page }) => {
  await page.route('**/baseline-http.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>HTTP contract</body></html>' }))
  await page.route('**/__baseline__', route => route.fulfill({ json: { headers: route.request().headers() } }))
  await page.route('**/__invalid_json__', route => route.fulfill({ contentType: 'text/html', body: '<html>SPA fallback</html>' }))
  await page.route('**/__no_content__', route => route.fulfill({ status: 204 }))
  await page.goto('/baseline-http.html')
  const results = await page.evaluate(async () => {
    await import('/@vite/env')
    const module = await import('/src/api/client.ts')
    const request = module.apiRequest || module.apiFetch || module.api
    const text = await request('/api/__baseline__', { method: 'POST', headers: new Headers({ 'x-baseline': 'preserved', 'content-type': 'text/plain' }), body: 'text' })
    const form = new FormData(); form.set('sample', 'file')
    const multipart = await request('/api/__baseline__', { method: 'POST', body: form })
    let rejected = false
    try { await request('/api/__invalid_json__') } catch { rejected = true }
    return { text, multipart, rejected, empty: await request('/api/__no_content__') === undefined }
  })
  expect(results.text.headers['x-baseline']).toBe('preserved')
  expect(results.text.headers['content-type']).toBe('text/plain')
  expect(results.multipart.headers['content-type']).toContain('multipart/form-data; boundary=')
  expect(results.rejected).toBe(true)
  expect(results.empty).toBe(true)
})

test('shell navigation, mobile modal and local logout remain usable', async ({ page }) => {
  await page.addInitScript(id => localStorage.setItem(id + ':auth-token', 'baseline-session'), config.appId)
  await page.route(/\/src\/App\.tsx(?:\?|$)/, route => route.fulfill({ contentType: 'text/javascript', body: "export { default } from '/baseline-tests/.runtime-harness.tsx'" }))
  await page.route(/\/src\/pages\/.*\.tsx(?:\?|$)/, async route => {
    if (/\/(?:Dashboard|Shell)\.tsx(?:\?|$)/.test(route.request().url())) return route.continue()
    await route.fulfill({ contentType: 'text/javascript', body: "export default function Page(){return '核心回归页面'}" })
  })
  await page.route(/^https?:\/\/[^/]+\/(?:api|admin\/api)\//, route => route.fulfill({ json: {} }))
  await page.route(/\/logout(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: '受控退出失败' } }))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  const navigation = page.locator('aside nav button[data-active]')
  await expect(navigation.first()).toBeVisible()
  const last = navigation.last(), first = navigation.first()
  const label = (await last.innerText()).trim()
  await last.click(); await first.click(); await last.click()
  await expect(last).toHaveAttribute('data-active', 'true')
  if (profile.desktopTitle !== false) await expect(page.locator('header h2')).toHaveText(label)
  else await expect(page).toHaveTitle(new RegExp(label))
  await page.setViewportSize({ width: 390, height: 844 })
  const trigger = page.locator('[data-mobile-nav-trigger]')
  await expect(trigger).toBeVisible()
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const overlay = page.locator('[data-state="open"].fixed.inset-0')
  expect(await overlay.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await page.keyboard.press('Tab')
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  if (profile.shell !== 'Shell' && !profile.redirectLogout) {
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '本地会话已退出' })).toBeVisible()
  }
  expect(errors).toEqual([])
})

test('controls preserve submitted values, custom options and selection after a failed deletion', async ({ page }) => {
  await page.route(/\/src\/App\.tsx(?:\?|$)/, route => route.fulfill({ contentType: 'text/javascript', body: "export { default } from '/baseline-tests/.runtime-harness.tsx'" }))
  await page.goto('/?controls=1')
  expect(await page.locator('#baseline-form').evaluate(form => (form as HTMLFormElement).checkValidity())).toBe(false)
  await page.getByRole('combobox', { name: '状态', exact: true }).click()
  await page.getByRole('option', { name: '正常', exact: true }).click()
  expect(await page.locator('#baseline-form').evaluate(form => new FormData(form as HTMLFormElement).get('status'))).toBe('active')
  expect(await page.locator('#baseline-form').evaluate(form => (form as HTMLFormElement).checkValidity())).toBe(true)
  const custom = page.getByRole('combobox', { name: '自定义筛选' })
  await expect(custom).toContainText('custom')
  await custom.click()
  await page.getByRole('dialog').getByRole('combobox').fill('new-value')
  await page.getByRole('option', { name: '添加：new-value', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(custom).toContainText('new-value')
  await page.getByRole('button', { name: '清空选择', exact: true }).click()
  await expect(custom).toContainText('请选择')
  await expect(page.locator('button button, button [role="button"]')).toHaveCount(0)
  await page.getByRole('checkbox', { name: '选择 sample', exact: true }).click()
  await page.getByRole('button', { name: '删除所选', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByText('已选 1 条', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除所选', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('受控删除失败')
  await expect(page.getByText('已选 1 条', { exact: true })).toBeVisible()
})
