import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type SettingsPatch, getSettings, updateSettings } from '@/api/settings'
import { InlineLoader } from '@/components/PageLoader'
import { PageSurface } from '@/components/layout/PageScaffold'
import { TabbedSettingsPage } from '@/components/layout/TabbedSettingsPage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useResource } from '@/lib/use-resource'

/**
 * 系统设置 —— MCDR 运行参数 + 修改管理员密码。
 * 数据走 useResource;保存通过 message 回传,组件内部统一弹全局 toast。
 */

type Tab = 'mcdr' | 'security'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'mcdr', label: 'MCDR 运行' },
  { key: 'security', label: '安全' },
]

export default function Settings() {
  const { data, loading, error, refresh } = useResource(() => getSettings(), [])
  const [activeTab, setActiveTab] = useState<Tab>('mcdr')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const [pythonExec, setPythonExec] = useState('')
  const [javaCmd, setJavaCmd] = useState('')
  const [minMem, setMinMem] = useState('')
  const [maxMem, setMaxMem] = useState('')
  const [tokenExpire, setTokenExpire] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  useEffect(() => {
    if (!data) return
    setPythonExec(data.python_executable)
    setJavaCmd(data.java_command)
    setMinMem(data.default_min_memory)
    setMaxMem(data.default_max_memory)
    setTokenExpire(String(data.token_expire_minutes))
  }, [data])

  const save = async () => {
    if (newPassword && newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: '两次输入的新密码不一致' })
      return
    }
    const patch: SettingsPatch = {
      python_executable: pythonExec.trim(),
      java_command: javaCmd.trim(),
      default_min_memory: minMem.trim(),
      default_max_memory: maxMem.trim(),
      token_expire_minutes: Number(tokenExpire) || undefined,
    }
    if (newPassword) patch.new_password = newPassword
    setSaving(true)
    try {
      await updateSettings(patch)
      setMessage({ type: 'success', text: '设置已保存' })
      setNewPassword('')
      setConfirmPassword('')
      refresh()
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof ApiError ? err.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <InlineLoader />
      </div>
    )
  }

  if (error) {
    return (
      <PageSurface>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            重试
          </Button>
        </div>
      </PageSurface>
    )
  }

  return (
    <TabbedSettingsPage
      title="系统设置"
      description="面板运行参数与安全配置。"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      indicatorId="settings-tabs"
      message={message}
      headerActions={
        <Button type="button" className="gap-2" onClick={save} disabled={saving}>
          <Save className="h-4 w-4" />
          保存
        </Button>
      }
    >
      {activeTab === 'mcdr' ? (
        <PageSurface title="MCDR 运行参数" description="新建/启动实例时使用的命令与默认值。">
          <div className="grid gap-5 sm:max-w-md">
            <div className="space-y-2">
              <Label htmlFor="python-exec">Python 可执行文件</Label>
              <Input id="python-exec" value={pythonExec} onChange={(e) => setPythonExec(e.target.value)} placeholder="python" />
              <p className="text-xs text-muted-foreground">用于以 <code>python -m mcdreforged</code> 启动实例,需已安装 MCDReforged。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="java-cmd">Java 命令</Label>
              <Input id="java-cmd" value={javaCmd} onChange={(e) => setJavaCmd(e.target.value)} placeholder="java" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="min-mem">默认最小内存</Label>
                <Input id="min-mem" value={minMem} onChange={(e) => setMinMem(e.target.value)} placeholder="1G" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="max-mem">默认最大内存</Label>
                <Input id="max-mem" value={maxMem} onChange={(e) => setMaxMem(e.target.value)} placeholder="2G" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="token-expire">登录有效期(分钟)</Label>
              <Input id="token-expire" value={tokenExpire} onChange={(e) => setTokenExpire(e.target.value)} inputMode="numeric" />
            </div>
          </div>
        </PageSurface>
      ) : (
        <PageSurface title="修改管理员密码" description="留空表示不修改。保存后旧登录态仍有效,直至过期。">
          <div className="grid gap-5 sm:max-w-md">
            <div className="space-y-2">
              <Label htmlFor="new-pwd">新密码</Label>
              <Input id="new-pwd" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-pwd">确认新密码</Label>
              <Input id="confirm-pwd" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
            </div>
          </div>
        </PageSurface>
      )}
    </TabbedSettingsPage>
  )
}
