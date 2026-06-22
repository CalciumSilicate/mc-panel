import { apiRequest, apiUpload } from '@/api/client'

/** 模组管理(本地 + Modrinth)。 */

export interface InstalledMod {
  file_name: string
  id: string
  name: string
  version: string
  loader: string
  size: number
  enabled: boolean
}

export interface ModrinthHit {
  project_id: string
  slug: string
  title: string
  description: string
  downloads: number
  icon_url: string | null
}

export interface ModrinthVersion {
  id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  date_published: string
}

export function listMods(serverId: number): Promise<InstalledMod[]> {
  return apiRequest<InstalledMod[]>(`/mods/server/${serverId}`)
}

export function switchMod(serverId: number, fileName: string, enable: boolean) {
  return apiRequest(
    `/mods/server/${serverId}/switch/${encodeURIComponent(fileName)}?enable=${enable}`,
    { method: 'POST', body: '{}' },
  )
}

export function deleteMod(serverId: number, fileName: string) {
  return apiRequest(`/mods/server/${serverId}/${encodeURIComponent(fileName)}`, { method: 'DELETE' })
}

export function uploadMod(serverId: number, file: File) {
  const fd = new FormData()
  fd.append('file', file)
  return apiUpload<{ file_name: string }>(`/mods/server/${serverId}/upload`, fd)
}

export function searchModrinth(params: {
  q: string
  mcVersion?: string
  loader?: string
  limit?: number
}): Promise<ModrinthHit[]> {
  const qs = new URLSearchParams({ q: params.q })
  if (params.mcVersion) qs.set('mc_version', params.mcVersion)
  if (params.loader) qs.set('loader', params.loader)
  if (params.limit) qs.set('limit', String(params.limit))
  return apiRequest<ModrinthHit[]>(`/mods/search?${qs.toString()}`)
}

export function modVersions(projectId: string, mcVersion?: string, loader?: string): Promise<ModrinthVersion[]> {
  const qs = new URLSearchParams({ project_id: projectId })
  if (mcVersion) qs.set('mc_version', mcVersion)
  if (loader) qs.set('loader', loader)
  return apiRequest<ModrinthVersion[]>(`/mods/versions?${qs.toString()}`)
}

export function installMod(serverId: number, versionId: string) {
  return apiRequest<{ file_name: string }>(`/mods/server/${serverId}/install`, {
    method: 'POST',
    body: JSON.stringify({ version_id: versionId }),
  })
}

// ---- 本地中央库 ----
export function listLibrary(): Promise<InstalledMod[]> {
  return apiRequest<InstalledMod[]>('/mods/library')
}

export function uploadToLibrary(file: File) {
  const fd = new FormData()
  fd.append('file', file)
  return apiUpload<{ file_name: string }>('/mods/library/upload', fd)
}

export function deleteFromLibrary(fileName: string) {
  return apiRequest(`/mods/library/${encodeURIComponent(fileName)}`, { method: 'DELETE' })
}

export function installFromLibrary(serverId: number, fileName: string) {
  return apiRequest<{ file_name: string }>(`/mods/server/${serverId}/install-from-library`, {
    method: 'POST',
    body: JSON.stringify({ file_name: fileName }),
  })
}
