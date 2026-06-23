import { apiRequest } from '@/api/client'

export interface StatMetric {
  key: string
  label: string
}

export interface LeaderRow {
  uuid: string
  name: string
  value: number
}

export function listStatMetrics(): Promise<StatMetric[]> {
  return apiRequest<StatMetric[]>('/stats/metrics')
}

export function getLeaderboard(serverId: number, metric: string, window: string): Promise<{ rows: LeaderRow[]; scanned_at: number | null }> {
  return apiRequest(`/stats/${serverId}/leaderboard?metric=${metric}&window=${window}`)
}

export function refreshStats(serverId: number): Promise<{ scanned_at: number | null }> {
  return apiRequest(`/stats/${serverId}/refresh`, { method: 'POST', body: '{}' })
}
