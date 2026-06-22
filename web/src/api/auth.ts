import { apiRequest, clearAuthToken, getAuthToken, setAuthToken } from '@/api/client'

/** 鉴权:用户名+密码;首次引导建 owner;可选注册。 */

export interface CurrentUser {
  id: number
  username: string
  role: string
  verified: boolean
  player_id: string
  // 仅 /auth/me 返回:进行中的验证
  verify_code?: string
  verify_target?: string
  created_at: string
}

export interface VerifyInfo {
  code: string
  player_id: string
  command: string
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

export function requestVerify(playerId: string): Promise<VerifyInfo> {
  return apiRequest<VerifyInfo>('/auth/verify/request', {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId }),
  })
}

export function cancelVerify() {
  return apiRequest('/auth/verify/cancel', { method: 'POST', body: '{}' })
}

export { getAuthToken, clearAuthToken }
