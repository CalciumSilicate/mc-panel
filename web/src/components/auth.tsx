import type { ReactNode } from 'react'

import type { CurrentUser } from '@/api/auth'
import { AuthContext, ROLE_ORDER } from '@/components/auth-context'

export function AuthProvider({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const roleAtLeast = (min: string) => (ROLE_ORDER[user.role] ?? 0) >= (ROLE_ORDER[min] ?? 0)
  return <AuthContext.Provider value={{ user, roleAtLeast }}>{children}</AuthContext.Provider>
}
