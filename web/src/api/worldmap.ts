import { apiRequest } from '@/api/client'

export interface MapPlayer {
  uuid: string
  name: string
}

export function getMapPlayers(
  serverId: number,
): Promise<{ players: MapPlayer[]; scanned_at: number | null; rcon_enabled: boolean; running: boolean }> {
  return apiRequest(`/map/${serverId}/players`)
}

export function getMapPositions(serverId: number, uuids: string[], dim: string, hours: number): Promise<{ tracks: Record<string, [number, number, number][]> }> {
  const u = encodeURIComponent(uuids.join(','))
  return apiRequest(`/map/${serverId}/positions?uuids=${u}&dim=${encodeURIComponent(dim)}&hours=${hours}`)
}

export function refreshMap(serverId: number): Promise<{ scanned_at: number | null }> {
  return apiRequest(`/map/${serverId}/refresh`, { method: 'POST', body: '{}' })
}

export interface MapMarker {
  id: number
  server_id: number
  dim: string
  name: string
  x: number
  y: number
  z: number
  icon: string
  color: string
  created_at: string
}

export interface MarkerInput {
  dim: string
  name: string
  x: number
  y: number
  z: number
  icon: string
  color: string
}

export function getMarkers(serverId: number, dim: string): Promise<{ markers: MapMarker[] }> {
  return apiRequest(`/map/${serverId}/markers?dim=${encodeURIComponent(dim)}`)
}

export function createMarker(serverId: number, input: MarkerInput): Promise<MapMarker> {
  return apiRequest(`/map/${serverId}/markers`, { method: 'POST', body: JSON.stringify(input) })
}

export function updateMarker(serverId: number, markerId: number, patch: Partial<MarkerInput>): Promise<MapMarker> {
  return apiRequest(`/map/${serverId}/markers/${markerId}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteMarker(serverId: number, markerId: number): Promise<{ ok: boolean }> {
  return apiRequest(`/map/${serverId}/markers/${markerId}`, { method: 'DELETE' })
}

export interface BasemapStatus {
  status: 'idle' | 'rendering' | 'done' | 'error'
  message: string
  rendered_at: number | null
}

export interface BasemapMeta {
  available: boolean
  minX?: number
  minZ?: number
  widthPx?: number
  heightPx?: number
  blocksPerPixel?: number
}

// 维度 key(minecraft:xxx)→ basemap 维度 id
export const DIM_ID: Record<string, string> = {
  'minecraft:overworld': 'overworld',
  'minecraft:the_nether': 'nether',
  'minecraft:the_end': 'the_end',
}

export function getBasemapStatus(serverId: number): Promise<BasemapStatus> {
  return apiRequest(`/map/${serverId}/basemap/status`)
}

export function renderBasemap(serverId: number): Promise<BasemapStatus> {
  return apiRequest(`/map/${serverId}/basemap/render`, { method: 'POST', body: '{}' })
}

export function getBasemapMeta(serverId: number, dimId: string): Promise<BasemapMeta> {
  return apiRequest(`/map/${serverId}/basemap/${dimId}/meta`)
}

// <img> 直链(浏览器直接加载,不经 apiRequest)
export function basemapImageUrl(serverId: number, dimId: string): string {
  return `/api/map/${serverId}/basemap/${dimId}/image.png`
}
