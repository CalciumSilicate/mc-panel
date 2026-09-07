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
  | 'queued'
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
  group_id: number | null
  group_name: string
  proxy_id: number | null
  start_command_override?: string
  mcdr_language?: string
  startup_commands?: string[]
  autostart_priority?: number
  rcon_enabled?: boolean
  rcon_port?: number
  sort_order?: number
  created_at: string
  status: ServerStatus
  needs_restart?: boolean
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
  group_id?: number | null
}

export function listServers(): Promise<ServerSummary[]> {
  return apiRequest<ServerSummary[]>('/servers')
}

/** 按给定 id 顺序整体重排列表(拖拽排序后持久化)。 */
export function reorderServers(ids: number[]): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>('/servers/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export type VersionChannel = 'release' | 'snapshot' | 'experimental'

export interface VelocityServerEntry {
  key: string
  addr: string
}

export interface VelocityConfig {
  motd: string
  show_max_players: number
  online_mode: boolean
  forwarding_mode: string
  /** [servers] 里的子服(只读,由「一键接线」维护) */
  servers: VelocityServerEntry[]
  /** try 回退顺序(可编辑) */
  try_servers: string[]
}

export function getVelocityConfig(id: number): Promise<VelocityConfig> {
  return apiRequest<VelocityConfig>(`/servers/${id}/velocity-config`)
}

export function updateVelocityConfig(id: number, cfg: VelocityConfig): Promise<VelocityConfig> {
  return apiRequest<VelocityConfig>(`/servers/${id}/velocity-config`, {
    method: 'PATCH',
    body: JSON.stringify(cfg),
  })
}

export interface WireResult {
  name: string
  status: 'ok' | 'unsupported' | 'error' | 'skipped'
  detail: string
}

export interface WiringStatus extends WireResult {
  id: number
  custom: boolean
}

export function getWiringStatus(proxyId: number): Promise<{ results: WiringStatus[] }> {
  return apiRequest(`/servers/proxy/${proxyId}/wiring-status`)
}

export interface CustomBackend {
  id: number
  proxy_id: number
  name: string
  host: string
  port: number
  created_at: string
}

export function listCustomBackends(proxyId: number): Promise<CustomBackend[]> {
  return apiRequest<CustomBackend[]>(`/servers/proxy/${proxyId}/custom-backends`)
}

export function addCustomBackend(
  proxyId: number,
  input: { name: string; host: string; port: number },
): Promise<CustomBackend> {
  return apiRequest<CustomBackend>(`/servers/proxy/${proxyId}/custom-backends`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function deleteCustomBackend(backendId: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/servers/proxy/custom-backends/${backendId}`, { method: 'DELETE' })
}

export function getProxySecret(proxyId: number): Promise<string> {
  return apiRequest<{ secret: string }>(`/servers/proxy/${proxyId}/secret`).then((r) => r.secret)
}

export function wireProxy(proxyId: number, secret = '', force = false): Promise<{ results: WireResult[] }> {
  return apiRequest<{ results: WireResult[] }>(`/servers/proxy/${proxyId}/wire`, { method: 'POST', body: JSON.stringify({ secret, force }) })
}

export function getSuggestedPort(): Promise<number> {
  return apiRequest<{ port: number }>('/servers/suggest-port').then((r) => r.port)
}

export function getServerVersions(
  type: ServerType,
  channel: VersionChannel = 'release',
  force = false,
): Promise<string[]> {
  const params = new URLSearchParams({ type, channel })
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
  loader_version?: string
  group_id?: number | null
  proxy_id?: number | null
  extra_jvm_args?: string
  auto_start?: boolean
  java_path_override?: string
  protected?: boolean
  start_command_override?: string
  mcdr_language?: string
  startup_commands?: string[]
  autostart_priority?: number
}

export function updateServer(id: number, patch: ServerUpdateInput): Promise<ServerSummary> {
  return apiRequest<ServerSummary>(`/servers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function previewStartCommand(id: number, draft: ServerUpdateInput): Promise<{ command: string[] }> {
  return apiRequest(`/servers/${id}/start-command-preview`, { method: 'POST', body: JSON.stringify(draft) })
}

export interface RconInfo {
  enabled: boolean
  port: number
  password: string
}

export function getRconInfo(id: number): Promise<RconInfo> {
  return apiRequest<RconInfo>(`/servers/${id}/rcon`)
}

export function setRcon(
  id: number,
  body: { enabled: boolean; port?: number; password?: string },
): Promise<ServerSummary> {
  return apiRequest<ServerSummary>(`/servers/${id}/rcon`, {
    method: 'POST',
    body: JSON.stringify(body),
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

export function forceStopServer(id: number): Promise<{ status: ServerStatus }> {
  return apiRequest<{ status: ServerStatus }>(`/servers/${id}/force-stop`, {
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
