import { ApiError, apiRequest, apiUpload, getAuthToken } from '@/api/client'

export interface LitematicaFile {
  name: string
  size_bytes: number
}

export interface Material {
  id: string
  count: number
}

export interface LitematicaInfo {
  regions: number
  size: [number, number, number]
  total_blocks: number
  materials: Material[]
}

export function listLitematica(): Promise<LitematicaFile[]> {
  return apiRequest<LitematicaFile[]>('/litematica')
}

export function uploadLitematica(file: File): Promise<{ name: string; info: LitematicaInfo }> {
  const fd = new FormData()
  fd.append('file', file)
  return apiUpload('/litematica/upload', fd)
}

export function getLitematicaInfo(name: string): Promise<LitematicaInfo> {
  return apiRequest<LitematicaInfo>(`/litematica/${encodeURIComponent(name)}/info`)
}

export function deleteLitematica(name: string): Promise<{ ok: boolean }> {
  return apiRequest(`/litematica/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export interface BuildInput {
  name: string
  server_id: number
  x: number
  y: number
  z: number
  place_air: boolean
}

export function buildLitematica(input: BuildInput): Promise<{ ok: boolean; started: boolean }> {
  return apiRequest('/litematica/build', { method: 'POST', body: JSON.stringify(input) })
}

export async function downloadLitematica(name: string): Promise<void> {
  const res = await fetch(`/api/litematica/${encodeURIComponent(name)}/download`, {
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
