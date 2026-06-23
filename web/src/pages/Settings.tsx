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
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useResource } from '@/lib/use-resource'

/**
 * 系统设置 —— MCDR 运行参数 + 访问(注册开关)。仅 admin+ 可见。
 */

type Tab = 'mcdr' | 'access' | 'qq'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'mcdr', label: 'MCDR 运行' },
  { key: 'access', label: '访问' },
  { key: 'qq', label: 'QQ 互通' },
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
  const [downloadProxy, setDownloadProxy] = useState('')
  const [portMin, setPortMin] = useState('')
  const [portMax, setPortMax] = useState('')
  const [allowRegister, setAllowRegister] = useState(false)
  const [onebotEnabled, setOnebotEnabled] = useState(false)
  const [onebotWsUrl, setOnebotWsUrl] = useState('')
  const [onebotToken, setOnebotToken] = useState('')
  const [javaPaths, setJavaPaths] = useState<string[]>([])
  const [newJavaPath, setNewJavaPath] = useState('')

  useEffect(() => {
    if (!data) return
    setPythonExec(data.python_executable)
    setJavaCmd(data.java_command)
    setMinMem(data.default_min_memory)
    setMaxMem(data.default_max_memory)
    setTokenExpire(String(data.token_expire_minutes))
    setDownloadProxy(data.download_proxy)
    setPortMin(String(data.port_min))
    setPortMax(String(data.port_max))
    setAllowRegister(data.allow_register)
    setOnebotEnabled(data.onebot_enabled)
    setOnebotWsUrl(data.onebot_ws_url)
    setOnebotToken(data.onebot_token)
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
    const patch: SettingsPatch = {
      python_executable: pythonExec.trim(),
      java_command: javaCmd.trim(),
      default_min_memory: minMem.trim(),
      default_max_memory: maxMem.trim(),
      token_expire_minutes: Number(tokenExpire) || undefined,
      download_proxy: downloadProxy.trim(),
      port_min: Number(portMin) || undefined,
      port_max: Number(portMax) || undefined,
      allow_register: allowRegister,
      onebot_enabled: onebotEnabled,
      onebot_ws_url: onebotWsUrl.trim(),
      onebot_token: onebotToken.trim(),
      java_paths: javaPaths,
    }
    setSaving(true)
    try {
      await updateSettings(patch)
      setMessage({ type: 'success', text: '设置已保存' })
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
          <div className="grid gap-5 sm:max-w-2xl">
            <div className="space-y-2">
              <Label htmlFor="python-exec">Python 可执行文件</Label>
              <Input id="python-exec" value={pythonExec} onChange={(e) => setPythonExec(e.target.value)} placeholder="python" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="java-cmd">默认 Java 命令</Label>
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
            <div className="space-y-2">
              <Label htmlFor="download-proxy">下载代理</Label>
              <Input id="download-proxy" value={downloadProxy} onChange={(e) => setDownloadProxy(e.target.value)} placeholder="http://127.0.0.1:7890" className="font-mono" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="port-min">自动分配端口·起</Label>
                <Input id="port-min" value={portMin} onChange={(e) => setPortMin(e.target.value)} inputMode="numeric" placeholder="25565" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="port-max">自动分配端口·止</Label>
                <Input id="port-max" value={portMax} onChange={(e) => setPortMax(e.target.value)} inputMode="numeric" placeholder="25999" />
              </div>
            </div>
          </div>

          <div className="mt-6 space-y-3 border-t border-border/60 pt-5 sm:max-w-2xl">
            <Label>Java 安装池</Label>
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
      ) : activeTab === 'access' ? (
        <PageSurface title="访问控制">
          <label className="flex items-center justify-between gap-4 sm:max-w-md">
            <span>
              <span className="block text-sm font-medium">允许自助注册</span>
              <span className="block text-xs text-muted-foreground">开启后,任何人可在登录页注册账号(角色为「用户」)</span>
            </span>
            <Switch checked={allowRegister} onCheckedChange={setAllowRegister} />
          </label>
        </PageSurface>
      ) : (
        <PageSurface title="QQ 互通(OneBot 11)">
          <div className="grid gap-5 sm:max-w-2xl">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">启用 QQ 互通</span>
                <span className="block text-xs text-muted-foreground">
                  面板作为 OneBot 客户端连接 LLBot 等(正向 ws);组内 MC 与绑定的 QQ 群双向互通
                </span>
              </span>
              <Switch checked={onebotEnabled} onCheckedChange={setOnebotEnabled} />
            </label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="ob-url">OneBot 正向 ws 地址</Label>
                <span className={cn('rounded-full px-2 py-0.5 text-[11px]', data?.onebot_connected ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>
                  {data?.onebot_connected ? '已连接' : '未连接'}
                </span>
              </div>
              <Input id="ob-url" value={onebotWsUrl} onChange={(e) => setOnebotWsUrl(e.target.value)} placeholder="ws://127.0.0.1:3001" className="font-mono" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-token">Access Token</Label>
              <Input id="ob-token" type="password" value={onebotToken} onChange={(e) => setOnebotToken(e.target.value)} placeholder="留空表示无 token" />
            </div>
            <p className="text-xs text-muted-foreground">QQ 群与互联组的绑定在「服务器实例 → 互联组」里设置。保存后会按新配置重连;连接状态刷新本页可见。</p>
          </div>
        </PageSurface>
      )}
    </TabbedSettingsPage>
  )
}
