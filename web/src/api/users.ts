import { apiRequest } from '@/api/client'
import type { CurrentUser } from '@/api/auth'

/** 用户管理(admin+)。 */
export type PanelUser = CurrentUser

export function listUsers(): Promise<PanelUser[]> {
  return apiRequest<PanelUser[]>('/users')
}

export function createUser(username: string, password: string, role: string): Promise<PanelUser> {
  return apiRequest<PanelUser>('/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, role }),
  })
}

export function updateUser(id: number, patch: { role?: string; new_password?: string }): Promise<PanelUser> {
  return apiRequest<PanelUser>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteUser(id: number) {
  return apiRequest(`/users/${id}`, { method: 'DELETE' })
}

export function transferOwner(id: number): Promise<PanelUser> {
  return apiRequest<PanelUser>(`/users/${id}/transfer-owner`, { method: 'POST', body: '{}' })
}
