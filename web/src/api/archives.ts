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
  owner_user_id: number | null
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

// 带上传进度的版本(fetch 不支持 upload progress,用 XHR)
export function uploadArchiveWithProgress(file: File, onProgress?: (pct: number) => void): Promise<Archive> {
  const fd = new FormData()
  fd.append('file', file)
  return new Promise<Archive>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/archives/upload')
    const token = getAuthToken()
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(Math.round((ev.loaded / ev.total) * 100))
    }
    xhr.onload = () => {
      let payload: unknown = {}
      try { payload = JSON.parse(xhr.responseText) } catch { /* 非 JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as Archive)
      } else {
        const msg = (payload as { error?: string } | null)?.error
        reject(new ApiError(typeof msg === 'string' ? msg : `HTTP ${xhr.status}`, xhr.status))
      }
    }
    xhr.onerror = () => reject(new ApiError('网络错误', 0))
    xhr.send(fd)
  })
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

export const ARCHIVE_EXTS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.tbz2', '.txz', '.tar', '.zip']

export async function downloadArchive(id: number, name: string, filename = ''): Promise<void> {
  const res = await fetch(`/api/archives/${id}/download`, {
    headers: { authorization: `Bearer ${getAuthToken()}` },
  })
  if (!res.ok) throw new ApiError('下载失败', res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const ext = ARCHIVE_EXTS.find((e) => filename.toLowerCase().endsWith(e)) ?? '.zip'
  a.download = `${name}${ext}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
