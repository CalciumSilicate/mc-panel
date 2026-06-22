import { createContext, useContext } from 'react'

import type { CurrentUser } from '@/api/auth'

export const ROLE_ORDER: Record<string, number> = { user: 1, helper: 2, admin: 3, owner: 4 }

export const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  helper: '协管',
  user: '用户',
}

export interface AuthValue {
  user: CurrentUser
  roleAtLeast: (role: string) => boolean
  // 可执行操作:未验证的 user 只读
  canOperate: boolean
  // 重新拉取当前用户(验证完成后刷新)
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export function roleAtLeast(role: string, min: string): boolean {
  return (ROLE_ORDER[role] ?? 0) >= (ROLE_ORDER[min] ?? 0)
}
