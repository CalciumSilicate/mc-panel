import { apiRequest } from '@/api/client'

/** 系统设置:MCDR 运行参数 + 管理员密码。 */

export interface JavaInstall {
  path: string
  major: number | null
}

export interface PanelSettings {
  python_executable: string
  java_command: string
  default_min_memory: string
  default_max_memory: string
  token_expire_minutes: number
  download_proxy: string
  allow_register: boolean
  onebot_enabled: boolean
  onebot_ws_url: string
  onebot_token: string
  onebot_connected: boolean
  java_installs: JavaInstall[]
}

export interface SettingsPatch {
  python_executable?: string
  java_command?: string
  default_min_memory?: string
  default_max_memory?: string
  token_expire_minutes?: number
  download_proxy?: string
  allow_register?: boolean
  onebot_enabled?: boolean
  onebot_ws_url?: string
  onebot_token?: string
  java_paths?: string[]
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
