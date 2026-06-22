import { useEffect, useState } from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'

import { ApiError } from '@/api/client'
import { cancelVerify, requestVerify } from '@/api/auth'
import { useAuth } from '@/components/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useGlobalToast } from '@/components/ui/use-global-toast'

/**
 * 未验证 user 的验证引导:填正版游戏ID → 生成验证码 → 游戏内 !!bind 完成绑定。
 * 仅当当前用户为未验证的 user 角色时渲染(由 Dashboard 控制)。
 */
export function VerifyPanel() {
  const { user, refresh } = useAuth()
  const { showToast } = useGlobalToast()
  const [playerId, setPlayerId] = useState('')
  const [busy, setBusy] = useState(false)

  const pending = Boolean(user.verify_code)

  // 验证进行中:轮询自身状态,绑定完成后会自动消失
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [pending, refresh])

  const request = async () => {
    if (!playerId.trim()) {
      showToast('error', '请填写正版游戏 ID')
      return
    }
    setBusy(true)
    try {
      await requestVerify(playerId.trim())
      await refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    setBusy(true)
    try {
      await cancelVerify()
      await refresh()
    } catch {
      // ignore
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-300">账号未验证 —— 当前为只读</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            验证后才能启停服务器、上传与恢复存档。绑定你的正版玩家即可完成验证。
          </p>

          {pending ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-border/70 bg-background/70 p-4">
                <p className="text-sm">
                  加入任意一个服务器,在<strong>聊天栏</strong>输入下面这条指令完成绑定:
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-primary/10 px-3 py-1.5 font-mono text-base font-semibold text-primary">
                    !!bind {user.verify_code}
                  </code>
                  <span className="text-xs text-muted-foreground">绑定玩家:{user.verify_target}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  等待游戏内绑定…
                </span>
                <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={busy}>
                  取消 / 换 ID
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="verify-pid">正版游戏 ID</Label>
                <Input
                  id="verify-pid"
                  value={playerId}
                  onChange={(e) => setPlayerId(e.target.value)}
                  placeholder="你的 Minecraft 玩家名"
                  className="w-56"
                  onKeyDown={(e) => e.key === 'Enter' && request()}
                />
              </div>
              <Button type="button" onClick={request} disabled={busy} className="gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                生成验证码
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
