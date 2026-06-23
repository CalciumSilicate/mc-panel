import { ApiError, apiRequest, getAuthToken } from '@/api/client'

export interface PcrcInstance {
  id: number
  name: string
  address: string
  port: number
  authenticate_type: 'offline' | 'microsoft'
  username: string
  running: boolean
}

export interface PcrcReplay {
  name: string
  size_bytes: number
}

export function listPcrc(): Promise<{ available: boolean; instances: PcrcInstance[] }> {
  return apiRequest('/pcrc')
}

export function installPcrc(): Promise<{ ok: boolean; available: boolean }> {
  return apiRequest('/pcrc/install', { method: 'POST', body: '{}' })
}

export interface PcrcCreateInput {
  name: string
  address: string
  port: number
  authenticate_type: string
  username: string
}

export function createPcrc(body: PcrcCreateInput): Promise<PcrcInstance> {
  return apiRequest('/pcrc', { method: 'POST', body: JSON.stringify(body) })
}

export function updatePcrc(id: number, body: Partial<PcrcCreateInput>): Promise<PcrcInstance> {
  return apiRequest(`/pcrc/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function deletePcrc(id: number): Promise<{ ok: boolean }> {
  return apiRequest(`/pcrc/${id}`, { method: 'DELETE' })
}

export function startPcrc(id: number): Promise<{ running: boolean }> {
  return apiRequest(`/pcrc/${id}/start`, { method: 'POST', body: '{}' })
}

export function stopPcrc(id: number): Promise<{ running: boolean }> {
  return apiRequest(`/pcrc/${id}/stop`, { method: 'POST', body: '{}' })
}

export function pcrcCommand(id: number, command: string): Promise<{ ok: boolean }> {
  return apiRequest(`/pcrc/${id}/command`, { method: 'POST', body: JSON.stringify({ command }) })
}

export function pcrcConsole(id: number): Promise<{ running: boolean; lines: string[] }> {
  return apiRequest(`/pcrc/${id}/console`)
}

export function pcrcReplays(id: number): Promise<PcrcReplay[]> {
  return apiRequest(`/pcrc/${id}/replays`)
}

export function deleteReplay(id: number, name: string): Promise<{ ok: boolean }> {
  return apiRequest(`/pcrc/${id}/replays/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function downloadReplay(id: number, name: string): Promise<void> {
  const res = await fetch(`/api/pcrc/${id}/replays/${encodeURIComponent(name)}/download`, {
    headers: { authorization: `Bearer ${getAuthToken()}` },
  })
  if (!res.ok) throw new ApiError('下载失败', res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
