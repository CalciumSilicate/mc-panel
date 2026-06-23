import { apiRequest } from '@/api/client'

export interface PresetField {
  path: string
  type: 'bool' | 'int' | 'string' | 'string_array' | 'role_level' | 'crontab' | 'date' | 'json'
  label: string
  min?: number
}

export interface Preset {
  key: string
  name: string
  description: string
  plugin_id: string
  fields: PresetField[]
}

export interface PresetConfig {
  installed: boolean
  values: Record<string, unknown>
}

export function listPresets(): Promise<Preset[]> {
  return apiRequest<Preset[]>('/configs')
}

export function getPresetConfig(key: string, serverId: number): Promise<PresetConfig> {
  return apiRequest<PresetConfig>(`/configs/${key}/${serverId}`)
}

export function updatePresetConfig(key: string, serverId: number, values: Record<string, unknown>): Promise<{ ok: boolean }> {
  return apiRequest(`/configs/${key}/${serverId}`, { method: 'PATCH', body: JSON.stringify({ values }) })
}

export function installPreset(key: string, serverId: number): Promise<{ ok: boolean }> {
  return apiRequest(`/configs/${key}/${serverId}/install`, { method: 'POST', body: '{}' })
}

export interface BatchResult {
  name: string
  status: 'ok' | 'unsupported' | 'error'
  detail: string
}

export function copyConfigTo(key: string, sourceId: number, targets: number[]): Promise<{ results: BatchResult[] }> {
  return apiRequest(`/configs/${key}/${sourceId}/copy-to`, { method: 'POST', body: JSON.stringify({ targets }) })
}

export function installPresetTo(key: string, targets: number[]): Promise<{ results: BatchResult[] }> {
  return apiRequest(`/configs/${key}/install-to`, { method: 'POST', body: JSON.stringify({ targets }) })
}
