import { FormEvent, useState } from 'react'
import { Boxes, Loader2, LogIn, UserPlus } from 'lucide-react'

import { ApiError } from '@/api/client'
import { login, register, setupOwner } from '@/api/auth'
import { ThemeToggleButton } from '@/components/theme'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BRAND_NAME } from '@/config'
import { motion } from '@/lib/motion'

interface LoginProps {
  mode: 'setup' | 'login'
  allowRegister: boolean
  onAuthenticated: () => void
}

export default function Login({ mode, allowRegister, onAuthenticated }: LoginProps) {
  const [registering, setRegistering] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isSetup = mode === 'setup'
  const effective = isSetup ? 'setup' : registering ? 'register' : 'login'

  const title = isSetup ? '初始化所有者' : registering ? '注册账号' : BRAND_NAME
  const subtitle = isSetup
    ? '创建第一个账号(所有者)'
    : registering
      ? '注册后角色为「用户」'
      : '输入用户名和密码登录'

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      if (effective === 'setup') await setupOwner(username.trim(), password)
      else if (effective === 'register') await register(username.trim(), password)
      else await login(username.trim(), password)
      onAuthenticated()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-bg flex min-h-screen items-center justify-center px-4 py-10">
      <div className="fixed right-4 top-4 z-10">
        <ThemeToggleButton />
      </div>
      <motion.form
        onSubmit={handleSubmit}
        className="glass-card w-full max-w-sm rounded-2xl p-6"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="dashboard-brand-mark flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="username">用户名</Label>
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={effective === 'login' ? 'current-password' : 'new-password'}
            />
          </div>
        </div>

        {error ? <div className="mt-3 text-sm text-destructive">{error}</div> : null}

        <Button type="submit" className="mt-5 w-full gap-2" disabled={submitting || !username.trim() || !password}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : effective === 'login' ? (
            <LogIn className="h-4 w-4" />
          ) : (
            <UserPlus className="h-4 w-4" />
          )}
          {effective === 'setup' ? '创建并进入' : effective === 'register' ? '注册' : '登录'}
        </Button>

        {!isSetup && allowRegister ? (
          <button
            type="button"
            className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground"
            onClick={() => {
              setRegistering((v) => !v)
              setError('')
            }}
          >
            {registering ? '已有账号?去登录' : '没有账号?注册一个'}
          </button>
        ) : null}
      </motion.form>
    </div>
  )
}
