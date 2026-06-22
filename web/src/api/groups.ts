import { apiRequest } from '@/api/client'

/** 互联组(纯组织/路由,不参与权限)。 */
export interface ServerGroup {
  id: number
  name: string
  bridge_enabled: boolean
  qq_group_ids: number[]
  created_at: string
  server_count: number
}

export function listGroups(): Promise<ServerGroup[]> {
  return apiRequest<ServerGroup[]>('/groups')
}

export function createGroup(name: string, bridgeEnabled = true): Promise<ServerGroup> {
  return apiRequest<ServerGroup>('/groups', {
    method: 'POST',
    body: JSON.stringify({ name, bridge_enabled: bridgeEnabled }),
  })
}

export function updateGroup(
  id: number,
  patch: { name?: string; bridge_enabled?: boolean; qq_group_ids?: number[] },
): Promise<ServerGroup> {
  return apiRequest<ServerGroup>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteGroup(id: number) {
  return apiRequest(`/groups/${id}`, { method: 'DELETE' })
}
