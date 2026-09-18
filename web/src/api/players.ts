import { apiRequest } from '@/api/client'

export interface PlayerEntry {
  name: string
  uuid: string
  op_level: number | null
  banned: boolean
  ban_reason: string
  mcdr_perm: string
  online: boolean
}

export function updatePlayer(serverId: number, name: string, patch: { op?: boolean; banned?: boolean; ban_reason?: string; mcdr_perm?: string }): Promise<PlayerEntry> {
  return apiRequest(`/players/${serverId}/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function listPlayers(serverId: number): Promise<PlayerEntry[]> {
  return apiRequest<PlayerEntry[]>(`/players/${serverId}`)
}
