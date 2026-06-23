import { apiRequest } from '@/api/client'

export interface PlayerEntry {
  name: string
  uuid: string
  op_level: number | null
  banned: boolean
  ban_reason: string
  mcdr_perm: string
}

export function listPlayers(serverId: number): Promise<PlayerEntry[]> {
  return apiRequest<PlayerEntry[]>(`/players/${serverId}`)
}
