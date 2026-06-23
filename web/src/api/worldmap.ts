import { apiRequest } from '@/api/client'

export interface MapPlayer {
  uuid: string
  name: string
}

export function getMapPlayers(serverId: number): Promise<{ players: MapPlayer[]; scanned_at: number | null }> {
  return apiRequest(`/map/${serverId}/players`)
}

export function getMapPositions(serverId: number, uuids: string[], dim: string, hours: number): Promise<{ tracks: Record<string, [number, number, number][]> }> {
  const u = encodeURIComponent(uuids.join(','))
  return apiRequest(`/map/${serverId}/positions?uuids=${u}&dim=${encodeURIComponent(dim)}&hours=${hours}`)
}

export function refreshMap(serverId: number): Promise<{ scanned_at: number | null }> {
  return apiRequest(`/map/${serverId}/refresh`, { method: 'POST', body: '{}' })
}
