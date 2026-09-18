import { apiRequest } from '@/api/client'
import type { ServerSummary } from '@/api/servers'

/** 仪表盘:宿主机资源占用 + 服务器概览。 */

export interface ResourceUsage {
  used_gb: number
  total_gb: number
  percent: number
}

export interface DashboardOverview {
  cpu_percent: number
  memory: ResourceUsage
  disk: ResourceUsage
  total_servers: number
  running_servers: number
  servers: ServerSummary[]
  sampled_at: string
  cpu_threads: number
  host_uptime_seconds: number
  available_memory_gb: number
  free_disk_gb: number
  archive_count: number
  archive_bytes: number
  recent_archives: { id: number; name: string; size: number; source: string; created_at: string }[]
  history: { time: number; cpu: number; memory: number }[]
  history_interval_seconds: number
}

export function getDashboardOverview(minutes = 5): Promise<DashboardOverview> {
  return apiRequest<DashboardOverview>(`/system/overview?history_minutes=${minutes}`)
}
