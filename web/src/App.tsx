import { lazy, Suspense, useCallback, useEffect, useState } from 'react'

import { type CurrentUser, getAuthToken, getBootstrap, getMe } from '@/api/auth'
import { ChunkLoadBoundary } from '@/components/ChunkLoadBoundary'
import { PageLoader } from '@/components/PageLoader'
import { AuthProvider } from '@/components/auth'
import { BRAND_NAME } from '@/config'

const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Login = lazy(() => import('@/pages/Login'))

type Phase = 'loading' | 'setup' | 'login' | 'ready'

/**
 * 应用根:鉴权门。先 /auth/bootstrap 判断是否需要首次引导建 owner;否则查登录态。
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [allowRegister, setAllowRegister] = useState(false)

  const load = useCallback(async () => {
    try {
      const boot = await getBootstrap()
      if (boot.needs_setup) {
        setPhase('setup')
        return
      }
      setAllowRegister(boot.allow_register)
      if (!getAuthToken()) {
        setPhase('login')
        return
      }
      const me = await getMe()
      setUser(me)
      setPhase('ready')
    } catch {
      setPhase('login')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onAuthenticated = useCallback(async () => {
    try {
      const me = await getMe()
      setUser(me)
      setPhase('ready')
    } catch {
      setPhase('login')
    }
  }, [])

  if (phase === 'loading') return <PageLoader />

  return (
    <ChunkLoadBoundary scopeLabel={BRAND_NAME}>
      <Suspense fallback={<PageLoader />}>
        {phase === 'ready' && user ? (
          <AuthProvider user={user}>
            <Dashboard
              onLogout={() => {
                setUser(null)
                setPhase('login')
              }}
            />
          </AuthProvider>
        ) : (
          <Login
            mode={phase === 'setup' ? 'setup' : 'login'}
            allowRegister={allowRegister}
            onAuthenticated={onAuthenticated}
          />
        )}
      </Suspense>
    </ChunkLoadBoundary>
  )
}
