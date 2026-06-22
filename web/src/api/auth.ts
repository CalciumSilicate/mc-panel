import { apiRequest, clearAuthToken, getAuthToken, setAuthToken } from '@/api/client'

/** 鉴权:用户名+密码;首次引导建 owner;可选注册。 */

export interface CurrentUser {
  id: number
  username: string
  role: string
  created_at: string
}

export interface Bootstrap {
  needs_setup: boolean
  allow_register: boolean
}

export function getBootstrap(): Promise<Bootstrap> {
  return apiRequest<Bootstrap>('/auth/bootstrap')
}

async function authPost(path: string, username: string, password: string): Promise<void> {
  const result = await apiRequest<{ token: string }>(path, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  setAuthToken(result.token)
}

export function login(username: string, password: string): Promise<void> {
  return authPost('/auth/login', username, password)
}

export function setupOwner(username: string, password: string): Promise<void> {
  return authPost('/auth/setup', username, password)
}

export function register(username: string, password: string): Promise<void> {
  return authPost('/auth/register', username, password)
}

export async function logout(): Promise<void> {
  try {
    await apiRequest('/auth/logout', { method: 'POST', body: '{}' })
  } finally {
    clearAuthToken()
  }
}

export function getMe(): Promise<CurrentUser> {
  return apiRequest<CurrentUser>('/auth/me')
}

export function changePassword(oldPassword: string, newPassword: string) {
  return apiRequest('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  })
}

export { getAuthToken, clearAuthToken }
