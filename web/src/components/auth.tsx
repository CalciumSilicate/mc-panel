import { useCallback, useState, type ReactNode } from 'react'

import { type CurrentUser, getMe } from '@/api/auth'
import { AuthContext, ROLE_ORDER } from '@/components/auth-context'

export function AuthProvider({ initialUser, children }: { initialUser: CurrentUser; children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser>(initialUser)

  const refresh = useCallback(async () => {
    try {
      setUser(await getMe())
    } catch {
      // 刷新失败保持原状;鉴权失效会由请求层处理
    }
  }, [])

  const roleAtLeast = (min: string) => (ROLE_ORDER[user.role] ?? 0) >= (ROLE_ORDER[min] ?? 0)
  const canOperate = user.role !== 'user' || user.verified

  return (
    <AuthContext.Provider value={{ user, roleAtLeast, canOperate, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}
