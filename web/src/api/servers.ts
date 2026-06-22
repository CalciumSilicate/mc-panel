import { apiRequest } from '@/api/client'

/**
 * 服务器实例(MCDR)相关接口。
 * 网络细节关在这里,页面只调类型化函数(见 README 约定 4)。
 */

export type ServerStatus =
  | 'installing'
  | 'new_setup'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error'

export interface InstallProgress {
  downloaded: number
  total: number
  percent: number
}

export interface ServerSummary {
  id: number
  name: string
  server_type: string
  mc_version: string
  loader_version: string
  min_memory: string
  max_memory: string
  port: number
  extra_jvm_args: string
  auto_start: boolean
  java_path_override: string
  protected: boolean
  created_at: string
  status: ServerStatus
  install?: InstallProgress | null
}

export type ServerType = 'vanilla' | 'fabric' | 'forge' | 'velocity'

export interface CreateServerInput {
  name: string
  server_type: ServerType
  mc_version: string
  loader_version: string
  min_memory: string
  max_memory: string
  port: number
}

export function listServers(): Promise<ServerSummary[]> {
  return apiRequest<ServerSummary[]>('/servers')
}

export function getServerVersions(type: ServerType, force = false): Promise<string[]> {
  const params = new URLSearchParams({ type })
  if (force) params.set('refresh', 'true')
  return apiRequest<{ versions: string[] }>(`/servers/versions?${params}`).then((r) => r.versions)
}

export function getLoaderVersions(type: ServerType, mcVersion = '', force = false): Promise<string[]> {
  const params = new URLSearchParams({ type })
  if (mcVersion) params.set('mc_version', mcVersion)
  if (force) params.set('refresh', 'true')
  return apiRequest<{ versions: string[] }>(`/servers/loaders?${params}`).then((r) => r.versions)
}

export interface JavaInfo {
  mc_version: string
  required_major: number | null
  satisfied: boolean
  chosen_major: number | null
  message: string | null
}

export function getJavaInfo(mcVersion: string): Promise<JavaInfo> {
  return apiRequest<JavaInfo>(`/servers/java-info?mc_version=${encodeURIComponent(mcVersion)}`)
}

export function createServer(input: CreateServerInput): Promise<{ id: number }> {
  return apiRequest<{ id: number }>('/servers', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export interface ServerUpdateInput {
  name?: string
  min_memory?: string
  max_memory?: string
  port?: number
  mc_version?: string
  extra_jvm_args?: string
  auto_start?: boolean
  java_path_override?: string
  protected?: boolean
}

export function updateServer(id: number, patch: ServerUpdateInput): Promise<ServerSummary> {
  return apiRequest<ServerSummary>(`/servers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export type ServerProperties = Record<string, string>

export function getProperties(id: number): Promise<ServerProperties> {
  return apiRequest<{ properties: ServerProperties }>(`/servers/${id}/properties`).then(
    (r) => r.properties,
  )
}

export function updateProperties(id: number, properties: ServerProperties): Promise<ServerProperties> {
  return apiRequest<{ properties: ServerProperties }>(`/servers/${id}/properties`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  }).then((r) => r.properties)
}

export function startServer(id: number): Promise<{ status: ServerStatus }> {
  return apiRequest<{ status: ServerStatus }>(`/servers/${id}/start`, {
    method: 'POST',
    body: '{}',
  })
}

export function stopServer(id: number): Promise<{ status: ServerStatus }> {
  return apiRequest<{ status: ServerStatus }>(`/servers/${id}/stop`, {
    method: 'POST',
    body: '{}',
  })
}

export function deleteServer(id: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/servers/${id}`, { method: 'DELETE' })
}

export function reinstallServer(id: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/servers/${id}/reinstall`, { method: 'POST', body: '{}' })
}

export function cancelInstall(id: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/servers/${id}/cancel-install`, { method: 'POST', body: '{}' })
}
