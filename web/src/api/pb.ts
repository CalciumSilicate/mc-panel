import { ApiError, apiRequest, apiUpload, getAuthToken } from '@/api/client'

export interface PBOverview {
  storage_root?: string
  db_version?: string
  backup_amount?: number
  db_path?: string
  db_file_size?: number
  blob_stored_size?: number
  blob_raw_size?: number
}

export interface PBBackupItem {
  id: number
  date: string
  stored_size: number
  raw_size: number
  creator: string
  comment: string
}

export interface PbCached {
  overview: PBOverview
  backups: PBBackupItem[]
  usage: number
  scanned_at: number
}

export function getPbCached(serverId: number): Promise<PbCached> {
  return apiRequest<PbCached>(`/pb/${serverId}/cached`)
}

export function pbRefresh(serverId: number): Promise<PbCached> {
  return apiRequest<PbCached>(`/pb/${serverId}/refresh`, { method: 'POST', body: '{}' })
}

export function pbOverview(serverId: number): Promise<PBOverview> {
  return apiRequest<PBOverview>(`/pb/${serverId}/overview`)
}

export function pbList(serverId: number): Promise<PBBackupItem[]> {
  return apiRequest<PBBackupItem[]>(`/pb/${serverId}/list`)
}

export function pbUsage(serverId: number): Promise<number> {
  return apiRequest<{ bytes: number }>(`/pb/${serverId}/usage`).then((r) => r.bytes)
}

export function pbImport(serverId: number, file: File): Promise<{ ok: boolean }> {
  const fd = new FormData()
  fd.append('file', file)
  return apiUpload(`/pb/${serverId}/import`, fd)
}

export function pbRestore(serverId: number, backupId: number, targetServerId: number): Promise<{ ok: boolean }> {
  return apiRequest(`/pb/${serverId}/restore`, {
    method: 'POST',
    body: JSON.stringify({ backup_id: backupId, target_server_id: targetServerId }),
  })
}

export async function pbExport(serverId: number, backupId: number): Promise<void> {
  const res = await fetch(`/api/pb/${serverId}/export?id=${backupId}`, {
    headers: { authorization: `Bearer ${getAuthToken()}` },
  })
  if (!res.ok) throw new ApiError('导出失败', res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `pb_${serverId}_${backupId}.tar`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
