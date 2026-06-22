import { useEffect, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type SettingsPatch, getSettings, updateSettings } from '@/api/settings'
import { InlineLoader } from '@/components/PageLoader'
import { PageSurface } from '@/components/layout/PageScaffold'
import { TabbedSettingsPage } from '@/components/layout/TabbedSettingsPage'
import { Badge } from '@/components/ui/badge'
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
  const [javaPaths, setJavaPaths] = useState<string[]>([])
  const [newJavaPath, setNewJavaPath] = useState('')

  useEffect(() => {
    if (!data) return
    setPythonExec(data.python_executable)
    setJavaCmd(data.java_command)
    setMinMem(data.default_min_memory)
    setMaxMem(data.default_max_memory)
    setTokenExpire(String(data.token_expire_minutes))
    setJavaPaths(data.java_installs.map((i) => i.path))
  }, [data])

  const majorOf = (path: string) => data?.java_installs.find((i) => i.path === path)?.major ?? null
  const addJavaPath = () => {
    const p = newJavaPath.trim()
    if (!p || javaPaths.includes(p)) return
    setJavaPaths((prev) => [...prev, p])
    setNewJavaPath('')
  }

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
      java_paths: javaPaths,
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
              <Label htmlFor="java-cmd">默认 Java 命令</Label>
              <Input id="java-cmd" value={javaCmd} onChange={(e) => setJavaCmd(e.target.value)} placeholder="java" />
              <p className="text-xs text-muted-foreground">未配置 Java 池、或版本未知时的兜底命令。</p>
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

          <div className="mt-6 space-y-3 border-t border-border/60 pt-5 sm:max-w-lg">
            <div>
              <Label>Java 安装池</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                登记多个 Java 可执行文件,启动实例时按 MC 版本自动选「满足要求里最低」的那个。保存后显示探测到的版本。
              </p>
            </div>
            <div className="space-y-2">
              {javaPaths.length === 0 ? (
                <p className="text-sm text-muted-foreground">尚未添加。</p>
              ) : (
                javaPaths.map((path) => {
                  const major = majorOf(path)
                  return (
                    <div key={path} className="flex items-center gap-2 rounded-md border border-border/70 px-3 py-2">
                      <Badge
                        variant="outline"
                        className={major == null
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}
                      >
                        {major == null ? '未识别' : `Java ${major}`}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{path}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setJavaPaths((prev) => prev.filter((p) => p !== path))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })
              )}
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={newJavaPath}
                onChange={(e) => setNewJavaPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addJavaPath()
                  }
                }}
                placeholder="Java 可执行文件路径,如 C:\\Java\\jdk-21\\bin\\java.exe"
                className="font-mono"
              />
              <Button type="button" variant="outline" className="gap-1.5 shrink-0" onClick={addJavaPath}>
                <Plus className="h-4 w-4" />
                添加
              </Button>
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
