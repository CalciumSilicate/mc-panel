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
}

export function getDashboardOverview(): Promise<DashboardOverview> {
  return apiRequest<DashboardOverview>('/system/overview')
}
