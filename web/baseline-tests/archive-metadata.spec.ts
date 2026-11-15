import { expect, test, type Page } from '@playwright/test'

async function archivePage(page: Page, failVersions = false) {
  await page.addInitScript(() => {
    localStorage.setItem('mcpanel:auth-token', 'test')
    localStorage.setItem('mcpanel:last-page', 'archives')
  })
  let archive = {
    id: 1, name: '测试世界', filename: 'test.zip', size: 1000, source: 'uploaded',
    source_server_id: null, mc_version: 'legacy-custom', notes: '原备注',
    owner_user_id: 7, operator_name: 'player', created_at: '2026-01-01T00:00:00Z',
  }
  const patches: Record<string, unknown>[] = []
  const queries: string[] = []
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request()
    const url = new URL(request.url())
    let json: unknown = {}
    if (url.pathname.endsWith('/bootstrap')) json = { needs_setup: false }
    else if (url.pathname.endsWith('/me')) json = { id: 7, username: 'player', role: 'user', verified: true }
    else if (url.pathname === '/api/servers') json = []
    else if (url.pathname === '/api/archives') json = [archive, { ...archive, id: 2, name: '其他人的存档', owner_user_id: 8 }]
    else if (url.pathname === '/api/archives/versions') {
      queries.push(url.search)
      if (failVersions) {
        await route.fulfill({ status: 502, json: { detail: 'offline' } })
        return
      }
      json = { versions: url.searchParams.get('channel') === 'snapshot' ? ['test-snapshot'] : ['26.3', '1.21.1'] }
    } else if (url.pathname === '/api/archives/1' && request.method() === 'PATCH') {
      const values = request.postDataJSON()
      patches.push(values)
      archive = { ...archive, ...values }
      json = archive
    }
    await route.fulfill({ json })
  })
  await page.goto('/')
  const row = page.getByRole('row').filter({ hasText: '测试世界' })
  await expect(row).toBeVisible()
  return { row, patches, queries }
}

test('archive notes persist and versions support catalog, refresh, custom values and clearing', async ({ page }) => {
  const { row, patches, queries } = await archivePage(page)
  await expect(page.getByRole('columnheader', { name: '备注', exact: true })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '其他人的存档' }).getByTitle('编辑', { exact: true })).toHaveCount(0)
  const dialog = page.getByRole('dialog', { name: '编辑存档' })
  await row.getByTitle('编辑', { exact: true }).click()
  const version = dialog.getByRole('combobox', { name: 'MC 版本' })
  await expect(version).toBeEnabled()
  await expect(version).toContainText('legacy-custom')
  await dialog.getByRole('button', { name: '刷新版本列表' }).click()
  await expect.poll(() => queries.some(query => query.includes('refresh=true'))).toBe(true)
  await expect(version).toBeEnabled()
  await version.click()
  await page.getByRole('option', { name: '1.21.1', exact: true }).click()
  await dialog.getByLabel('备注', { exact: true }).fill('出生点备份\n保留红石建筑')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row.getByText('出生点备份\n保留红石建筑', { exact: true })).toBeVisible()
  expect(patches[0]).toMatchObject({ mc_version: '1.21.1', notes: '出生点备份\n保留红石建筑' })

  await row.getByTitle('编辑', { exact: true }).click()
  await dialog.getByRole('button', { name: '正式版', exact: true }).click()
  await expect.poll(() => queries.some(query => query.includes('channel=snapshot'))).toBe(true)
  await expect(version).toBeEnabled()
  await expect(version).toContainText('1.21.1')
  await version.click()
  await page.getByRole('option', { name: 'test-snapshot', exact: true }).click()
  await dialog.getByRole('button', { name: '自定义版本', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'MC 版本' })).toHaveValue('test-snapshot')
  await dialog.getByRole('textbox', { name: 'MC 版本' }).fill('special-26.3')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.getByText('special-26.3', { exact: true })).toBeVisible()

  await row.getByTitle('编辑', { exact: true }).click()
  await expect(version).toContainText('special-26.3')
  await expect(dialog.getByLabel('备注', { exact: true })).toHaveValue('出生点备份\n保留红石建筑')
  await dialog.getByRole('button', { name: '自定义版本', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'MC 版本' }).fill('')
  await dialog.getByLabel('备注', { exact: true }).fill('')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(patches.at(-1)).toMatchObject({ mc_version: '', notes: '' })
})

test('unavailable catalog still allows custom versions and note editing', async ({ page }) => {
  const { row, patches } = await archivePage(page, true)
  await row.getByTitle('编辑', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑存档' })
  await expect(dialog.getByRole('alert')).toContainText('版本列表加载失败')
  await dialog.getByRole('button', { name: '自定义版本', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'MC 版本' }).fill('offline-custom')
  await dialog.getByLabel('备注', { exact: true }).fill('网络中断时编辑')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(patches.at(-1)).toMatchObject({ mc_version: 'offline-custom', notes: '网络中断时编辑' })
})
