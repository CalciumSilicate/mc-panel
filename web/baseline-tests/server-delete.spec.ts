import { expect, test, type Page } from '@playwright/test'

async function mockServers(page: Page, role = 'admin') {
  await page.addInitScript(() => {
    localStorage.setItem('mcpanel:auth-token', 'test')
    localStorage.setItem('mcpanel:last-page', 'servers')
  })
  const base = {
    server_type: 'vanilla', mc_version: '26.3', loader_version: '',
    min_memory: '1G', max_memory: '2G', auto_start: false, startup_commands: [],
    protected: false, status: 'stopped',
  }
  let servers = [
    { ...base, id: 1, name: '待删除实例', port: 25565 },
    { ...base, id: 2, name: '保护实例', port: 25566, protected: true },
    { ...base, id: 3, name: '安装实例', port: 25567, status: 'installing' },
  ]
  const state = { deletes: 0, fail: false, release: null as (() => void) | null, hold: false }
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'DELETE' && path === '/api/servers/1') {
      state.deletes += 1
      if (state.hold) await new Promise<void>(resolve => { state.release = resolve })
      if (state.fail) {
        await route.fulfill({ status: 409, json: { detail: '实例文件被占用，请稍后重试' } })
      } else {
        servers = servers.filter(server => server.id !== 1)
        await route.fulfill({ json: { ok: true } })
      }
      return
    }
    let json: unknown = {}
    if (path.endsWith('/bootstrap')) json = { needs_setup: false }
    else if (path.endsWith('/me')) json = { id: 1, username: role, role, verified: true }
    else if (path === '/api/servers') json = servers
    else if (path === '/api/groups') json = []
    await route.fulfill({ json })
  })
  await page.goto('/')
  return state
}

test('delete is available in the row, requires confirmation and blocks duplicate requests', async ({ page }) => {
  const state = await mockServers(page)
  const row = page.getByRole('row').filter({ hasText: '待删除实例' })
  const button = row.getByRole('button', { name: '删除服务器', exact: true })
  await expect(button).toBeEnabled()
  await expect(page.getByRole('row').filter({ hasText: '保护实例' }).getByRole('button', { name: '删除服务器' })).toBeDisabled()
  await expect(page.getByRole('row').filter({ hasText: '安装实例' }).getByRole('button', { name: '删除服务器' })).toBeDisabled()

  await button.click()
  const confirmation = page.getByRole('dialog')
  await expect(confirmation).toContainText('删除服务器「待删除实例」')
  await expect(confirmation).toContainText('不可恢复')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  expect(state.deletes).toBe(0)
  await expect(row).toBeVisible()

  state.hold = true
  await button.click()
  await confirmation.getByRole('button', { name: '删除服务器', exact: true }).click()
  await expect.poll(() => state.deletes).toBe(1)
  await expect(button).toBeDisabled()
  state.release?.()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: '保护实例' })).toBeVisible()
  expect(state.deletes).toBe(1)
})

test('failed deletion preserves the row and allows retry', async ({ page }) => {
  const state = await mockServers(page)
  state.fail = true
  const row = page.getByRole('row').filter({ hasText: '待删除实例' })
  const remove = async () => {
    await row.getByRole('button', { name: '删除服务器', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除服务器', exact: true }).click()
  }
  await remove()
  await expect(page.getByText(/实例文件被占用，请稍后重试/)).toBeVisible()
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: '删除服务器', exact: true })).toBeEnabled()
  state.fail = false
  await remove()
  await expect(row).toHaveCount(0)
  expect(state.deletes).toBe(2)
})

for (const role of ['user', 'helper']) {
  test(`${role} cannot see server deletion controls`, async ({ page }) => {
    const state = await mockServers(page, role)
    await expect(page.getByRole('row').filter({ hasText: '待删除实例' })).toBeVisible()
    await expect(page.getByRole('button', { name: '删除服务器', exact: true })).toHaveCount(0)
    expect(state.deletes).toBe(0)
  })
}
