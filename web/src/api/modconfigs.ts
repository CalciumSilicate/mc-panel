import { apiRequest } from '@/api/client'

export interface ModPresetField {
  path: string
  type: 'bool' | 'int' | 'string'
  label: string
  min?: number
}

export interface ModPreset {
  key: string
  name: string
  description: string
  server_types: string[]
  fields: ModPresetField[]
}

export interface ModPresetConfig {
  installed: boolean
  applicable: boolean
  values: Record<string, unknown>
}

export function listModPresets(): Promise<ModPreset[]> {
  return apiRequest<ModPreset[]>('/modconfigs')
}

export interface ModPresetStatus {
  status: Record<string, boolean>
  scanned_at: number | null
}

export function getModPresetStatus(serverId: number): Promise<ModPresetStatus> {
  return apiRequest<ModPresetStatus>(`/modconfigs/status/${serverId}`)
}

export function refreshModPresetStatus(serverId: number): Promise<ModPresetStatus> {
  return apiRequest<ModPresetStatus>(`/modconfigs/refresh/${serverId}`, { method: 'POST', body: '{}' })
}

export function getModPresetConfig(key: string, serverId: number): Promise<ModPresetConfig> {
  return apiRequest<ModPresetConfig>(`/modconfigs/${key}/${serverId}`)
}

export function updateModPresetConfig(key: string, serverId: number, values: Record<string, unknown>): Promise<{ ok: boolean }> {
  return apiRequest(`/modconfigs/${key}/${serverId}`, { method: 'PATCH', body: JSON.stringify({ values }) })
}

export function installModPreset(key: string, serverId: number): Promise<{ ok: boolean }> {
  return apiRequest(`/modconfigs/${key}/${serverId}/install`, { method: 'POST', body: '{}' })
}
