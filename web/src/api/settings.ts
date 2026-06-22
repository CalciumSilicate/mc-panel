import { apiRequest } from '@/api/client'

/** 系统设置:MCDR 运行参数 + 管理员密码。 */

export interface PanelSettings {
  python_executable: string
  java_command: string
  default_min_memory: string
  default_max_memory: string
  token_expire_minutes: number
}

export interface SettingsPatch {
  python_executable?: string
  java_command?: string
  default_min_memory?: string
  default_max_memory?: string
  token_expire_minutes?: number
  new_password?: string
}

export function getSettings(): Promise<PanelSettings> {
  return apiRequest<PanelSettings>('/settings')
}

export function updateSettings(patch: SettingsPatch): Promise<PanelSettings> {
  return apiRequest<PanelSettings>('/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}
