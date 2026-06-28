import { apiRequest } from '@/api/client'

export type StatSampleType = 'important' | 'normal' | 'ignored'

export interface StatMetric {
  key: string
  label: string
  sample_type: StatSampleType
}

export interface StatPlayer {
  uuid: string
  name: string
}

export interface LeaderRow {
  uuid: string
  name: string
  value: number
}

function paramsOf(input: Record<string, string | number | string[] | undefined>) {
  const p = new URLSearchParams()
  Object.entries(input).forEach(([key, value]) => {
    if (value === undefined) return
    if (Array.isArray(value)) value.forEach((v) => p.append(key, v))
    else p.set(key, String(value))
  })
  return p.toString()
}

export function listStatMetrics(category = 'all', q = '', limit = 300): Promise<StatMetric[]> {
  return apiRequest<StatMetric[]>(`/stats/metrics?${paramsOf({ category, q, limit })}`)
}

export function listStatPlayers(serverId: number): Promise<{ players: StatPlayer[] }> {
  return apiRequest(`/stats/${serverId}/players`)
}

export function getLeaderboard(
  serverId: number,
  metrics: string[],
  window: string,
  limit = 100,
): Promise<{ rows: LeaderRow[]; scanned_at: number | null }> {
  return apiRequest(`/stats/${serverId}/leaderboard?${paramsOf({ metrics, window, limit })}`)
}

export function refreshStats(serverId: number, scope: 'important' | 'full' = 'important'): Promise<{ scanned_at: number | null }> {
  return apiRequest(`/stats/${serverId}/refresh?${paramsOf({ scope })}`, { method: 'POST', body: '{}' })
}

export function getStatSeries(args: {
  serverId: number
  uuids: string[]
  metrics: string[]
  mode: 'delta' | 'total'
  granularity: string
  hours: number
}): Promise<{ points: Record<string, [number, number][]> }> {
  const { serverId, ...rest } = args
  return apiRequest(`/stats/${serverId}/series?${paramsOf(rest)}`)
}
