import { ApiError, apiRequest, apiUpload, getAuthToken } from '@/api/client'

/** 世界存档管理。 */
export interface Archive {
  id: number
  name: string
  filename: string
  size: number
  source: string
  source_server_id: number | null
  mc_version: string
  created_at: string
}

export function listArchives(): Promise<Archive[]> {
  return apiRequest<Archive[]>('/archives')
}

export function createArchiveFromServer(serverId: number): Promise<{ job_id: string }> {
  return apiRequest<{ job_id: string }>(`/archives/from-server/${serverId}`, {
    method: 'POST',
    body: '{}',
  })
}

export function uploadArchive(file: File): Promise<Archive> {
  const fd = new FormData()
  fd.append('file', file)
  return apiUpload<Archive>('/archives/upload', fd)
}

export function deleteArchive(id: number) {
  return apiRequest(`/archives/${id}`, { method: 'DELETE' })
}

export function updateArchive(id: number, patch: { name?: string; mc_version?: string }): Promise<Archive> {
  return apiRequest<Archive>(`/archives/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function uploadArchiveWithVersion(file: File, mcVersion: string): Promise<Archive> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('mc_version', mcVersion)
  return apiUpload<Archive>('/archives/upload', fd)
}

export function restoreArchive(id: number, serverId: number): Promise<{ job_id: string }> {
  return apiRequest<{ job_id: string }>(`/archives/${id}/restore/${serverId}`, {
    method: 'POST',
    body: '{}',
  })
}

export async function downloadArchive(id: number, name: string): Promise<void> {
  const res = await fetch(`/api/archives/${id}/download`, {
    headers: { authorization: `Bearer ${getAuthToken()}` },
  })
  if (!res.ok) throw new ApiError('下载失败', res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
