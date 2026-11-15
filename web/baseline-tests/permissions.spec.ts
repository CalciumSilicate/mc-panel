import { expect, test, type Page } from '@playwright/test'

async function openPage(page: Page, view: string, role: string, verified = true) {
  await page.addInitScript(view => {
    localStorage.setItem('mcpanel:auth-token', 'permissions-test')
    localStorage.setItem('mcpanel:last-page', view)
  }, view)
  const calls: string[] = []
  const commands: string[] = []
  const state = { roomsFail: false }
  const server = {
    id: 1, name: '普通实例', server_type: 'vanilla', mc_version: '26.3',
    min_memory: '1G', max_memory: '2G', status: 'running', protected: false,
    port: 25565, auto_start: false, startup_commands: [],
  }
  const archive = {
    id: 1, name: '自己的存档', filename: 'world.zip', size: 10, source: 'uploaded',
    source_server_id: null, mc_version: '26.3', notes: '', owner_user_id: 7,
    operator_name: 'player', created_at: '2026-01-01T00:00:00Z',
  }
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    calls.push(path)
    let json: unknown = {}
    if (path.endsWith('/bootstrap')) json = { needs_setup: false }
    else if (path.endsWith('/me')) json = { id: 7, username: role, role, verified }
    else if (path === '/api/servers') json = [server,
      { ...server, id: 2, name: '保护实例', protected: true },
      { ...server, id: 3, name: '保护安装失败', protected: true, status: 'error' },
    ]
    else if (path === '/api/groups') {
      if (role === 'user') return route.fulfill({ status: 403, json: { detail: '权限不足' } })
      json = []
    } else if (path === '/api/chat/rooms') {
      if (state.roomsFail) return route.fulfill({ status: 503, json: { detail: 'unavailable' } })
      json = [{ id: 1, name: '玩家大厅' }]
    } else if (path === '/api/chat/1/members') json = { players: [], qq: [] }
    else if (path === '/api/archives') json = [archive, { ...archive, id: 2, name: '他人的存档', owner_user_id: 8 }]
    else if (path === '/api/system/overview') json = {
      cpu_percent: 10, cpu_threads: 8, memory: { used_gb: 2, total_gb: 8, percent: 25 },
      disk: { used_gb: 10, total_gb: 100, percent: 10 }, available_memory_gb: 6, free_disk_gb: 90,
      total_servers: 1, running_servers: 1,
      servers: [{ id: 1, name: '普通实例', server_type: 'vanilla', mc_version: '26.3', max_memory: '2G', status: 'running' }],
      sampled_at: '2026-01-01T00:00:00Z', history: [], history_interval_seconds: 5,
    }
    await route.fulfill({ json })
  })
  await page.routeWebSocket(/\/api\/servers\/\d+\/console/, ws => {
    ws.send(JSON.stringify({ type: 'log', line: '测试日志' }))
    ws.onMessage(message => commands.push(String(message)))
  })
  await page.routeWebSocket(/\/api\/chat\/ws\//, ws => {
    ws.send(JSON.stringify({ source: 'web', sender: 'player', text: '聊天室可用' }))
  })
  await page.goto('/')
  return { calls, commands, state }
}

for (const verified of [false, true]) {
  test(`user chat loads without group-management access; verified=${verified}`, async ({ page }) => {
    const { calls } = await openPage(page, 'chat', 'user', verified)
    await expect(page.getByText('聊天室可用', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox')).toContainText('玩家大厅')
    const send = page.getByRole('button', { name: '发送', exact: true })
    if (verified) {
      await page.getByRole('textbox').fill('hello')
      await send.click()
      expect(calls).toContain('/api/chat/1/send')
    } else await expect(send).toBeDisabled()
    expect(calls).toContain('/api/chat/rooms')
    expect(calls).not.toContain('/api/groups')
  })
}

for (const [role, verified] of [['user', false], ['user', true], ['helper', false]] as const) {
  test(`archive buttons respect verification and ownership: ${role}/${verified}`, async ({ page }) => {
    await openPage(page, 'archives', role, verified)
    for (const name of ['自己的存档', '他人的存档']) {
      const row = page.getByRole('row').filter({ hasText: name })
      await expect(row).toBeVisible()
      const owns = role === 'helper' || name === '自己的存档'
      await expect(row.getByTitle('下载', { exact: true })).toHaveCount(owns ? 1 : 0)
      for (const action of ['恢复', '编辑', '删除']) {
        await expect(row.getByTitle(action, { exact: true })).toHaveCount(owns && (verified || role === 'helper') ? 1 : 0)
      }
    }
  })
}

for (const role of ['helper', 'admin', 'owner']) {
  test(`${role} console command controls match server authorization`, async ({ page }) => {
    const { commands } = await openPage(page, 'servers', role)
    for (const name of ['普通实例', '保护实例']) {
      const row = page.getByRole('row').filter({ hasText: name })
      await row.getByTitle('控制台', { exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('测试日志', { exact: true })).toBeVisible()
      if (role === 'helper') {
        await expect(dialog.getByPlaceholder('仅管理员可发送控制台命令')).toBeDisabled()
        await expect(dialog.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
        const stop = dialog.getByRole('button', { name: '停止', exact: true })
        if (name === '保护实例') await expect(stop).toBeDisabled()
        else await expect(stop).toBeEnabled()
      } else {
        await dialog.getByRole('textbox').fill('say hello')
        await dialog.getByRole('button', { name: '发送', exact: true }).click()
        await expect.poll(() => commands.length).toBe(name === '普通实例' ? 1 : 2)
      }
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
    if (role === 'helper') expect(commands).toEqual([])
    else await expect(page.getByRole('row').filter({ hasText: '保护安装失败' })
      .getByRole('button', { name: '实例受保护，请先取消保护', exact: true })).toBeDisabled()
  })
}

test('player overview renders the reduced response without management data', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openPage(page, 'overview', 'user')
  await expect(page.getByText('在线服务器', { exact: true })).toBeVisible()
  await expect(page.getByText('数据所在磁盘', { exact: true })).toBeVisible()
  await expect(page.getByText('普通实例', { exact: true })).toBeVisible()
  for (const label of ['待处理实例', '自动启动', '运行检查', '世界存档']) {
    await expect(page.getByText(label, { exact: true })).toHaveCount(0)
  }
  expect(errors).toEqual([])
})
