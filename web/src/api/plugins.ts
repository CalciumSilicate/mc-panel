import { apiRequest, apiUpload } from '@/api/client'

/** MCDR 插件管理。 */

export interface InstalledPlugin {
  file_name: string
  id: string
  name: string
  version: string
  authors: string[]
  enabled: boolean
  is_dir: boolean
}

export interface CataloguePlugin {
  id: string
  name: string
  version: string
  description: string
  authors: string[]
}

export function listPlugins(serverId: number): Promise<InstalledPlugin[]> {
  return apiRequest<InstalledPlugin[]>(`/plugins/server/${serverId}`)
}

export function getCatalogue(force = false): Promise<CataloguePlugin[]> {
  return apiRequest<CataloguePlugin[]>(`/plugins/catalogue${force ? '?refresh=true' : ''}`)
}

export function switchPlugin(serverId: number, fileName: string, enable: boolean) {
  return apiRequest(
    `/plugins/server/${serverId}/switch/${encodeURIComponent(fileName)}?enable=${enable}`,
    { method: 'POST', body: '{}' },
  )
}

export function deletePlugin(serverId: number, fileName: string) {
  return apiRequest(`/plugins/server/${serverId}/${encodeURIComponent(fileName)}`, {
    method: 'DELETE',
  })
}

export function installPlugin(serverId: number, pluginId: string, version?: string) {
  return apiRequest<{ file_name: string; requirements_ok: boolean }>(
    `/plugins/server/${serverId}/install`,
    { method: 'POST', body: JSON.stringify({ plugin_id: pluginId, version }) },
  )
}

export function uploadPlugin(serverId: number, file: File) {
  const fd = new FormData()
  fd.append('file', file)
  return apiUpload<{ file_name: string }>(`/plugins/server/${serverId}/upload`, fd)
}
