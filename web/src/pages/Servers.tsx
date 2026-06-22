import { useEffect, useState } from 'react'
import { Ban, Download, Loader2, Pencil, Play, Plus, RefreshCw, Server, Square, Terminal, Trash2 } from 'lucide-react'

import {
  type JavaInfo,
  type ServerSummary,
  type ServerType,
  type VersionChannel,
  cancelInstall,
  createServer,
  deleteServer,
  type VelocityConfig,
  getJavaInfo,
  getLoaderVersions,
  getProperties,
  getServerVersions,
  getVelocityConfig,
  listServers,
  reinstallServer,
  startServer,
  stopServer,
  updateProperties,
  updateServer,
  updateVelocityConfig,
} from '@/api/servers'
import { type JavaInstall, getSettings } from '@/api/settings'
import { useAuth } from '@/components/auth-context'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ServerConsoleDialog } from '@/components/ServerConsoleDialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { ApiError } from '@/api/client'
import { SERVER_STATUS_META } from '@/lib/server-status'
import { cn } from '@/lib/utils'
import { useResource } from '@/lib/use-resource'

const TYPE_LABEL: Record<string, string> = {
  vanilla: '原版',
  fabric: 'Fabric',
  forge: 'Forge',
  velocity: 'Velocity',
}

const CHANNEL_LABEL: Record<VersionChannel, string> = {
  release: '正式版',
  snapshot: '快照版',
  experimental: '实验版',
}

/**
 * 服务器实例 —— 列表 + 新建(vanilla/fabric/forge/velocity)+ 启停/删除。
 * 列表每 4s 自动刷新一次,以便反映「安装中 → 已停止」的状态变化。
 */
export default function Servers() {
  const { roleAtLeast, canOperate } = useAuth()
  const canAdmin = roleAtLeast('admin')
  const canHelper = roleAtLeast('helper')
  const { data, loading, error, refresh } = useResource(() => listServers(), [])
  const { showToast } = useGlobalToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [consoleServer, setConsoleServer] = useState<ServerSummary | null>(null)
  const [editServer, setEditServer] = useState<ServerSummary | null>(null)

  useEffect(() => {
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const runAction = async (id: number, action: () => Promise<unknown>, okText: string) => {
    setBusyId(id)
    try {
      await action()
      showToast('success', okText)
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <PageShell
      title="服务器实例"
      description="管理由本面板托管的 MCDR 实例。"
      width="7xl"
      actions={
        <>
          <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </Button>
          {canAdmin ? (
            <Button type="button" className="gap-2" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新建服务器
            </Button>
          ) : null}
        </>
      }
    >
      {error ? (
        <PageSurface>
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              重试
            </Button>
          </div>
        </PageSurface>
      ) : loading && !data ? (
        <div className="flex h-64 items-center justify-center">
          <InlineLoader />
        </div>
      ) : (
        <PageSurface bodyClassName="p-0">
          {!data || data.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-14 text-center text-sm text-muted-foreground">
              <Server className="h-9 w-9 opacity-40" />
              <p>还没有服务器实例。</p>
              {canAdmin ? (
                <Button type="button" className="gap-2" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" />
                  新建第一个服务器
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="ops-table-shell border-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>版本</TableHead>
                    <TableHead>加载器/核心</TableHead>
                    <TableHead>内存</TableHead>
                    <TableHead>端口</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((server) => {
                    const meta = SERVER_STATUS_META[server.status]
                    const busy = busyId === server.id
                    const installing = server.status === 'installing'
                    const starting = server.status === 'starting'
                    const active = server.status === 'running' || starting
                    return (
                      <TableRow key={server.id}>
                        <TableCell className="font-medium">{server.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[11px]">{TYPE_LABEL[server.server_type] ?? server.server_type}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{server.mc_version || '—'}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{server.loader_version || '—'}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {server.min_memory} ~ {server.max_memory}
                        </TableCell>
                        <TableCell className="font-mono text-muted-foreground">{server.port}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('gap-1 text-[11px]', meta.tone)}>
                            {installing || starting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                            {meta.label}
                            {installing && server.install ? ` ${server.install.percent}%` : ''}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1.5">
                            {canAdmin ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                disabled={server.status === 'installing'}
                                title="编辑"
                                onClick={() => setEditServer(server)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            ) : null}
                            {canHelper ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                disabled={server.status === 'installing' || server.status === 'new_setup'}
                                title="控制台"
                                onClick={() => setConsoleServer(server)}
                              >
                                <Terminal className="h-4 w-4" />
                              </Button>
                            ) : null}
                            {active && (server.protected ? canAdmin : canOperate) ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                                disabled={busy}
                                onClick={() => runAction(server.id, () => stopServer(server.id), '已发送停止命令')}
                              >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                                停止
                              </Button>
                            ) : null}
                            {canOperate && !active ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                                disabled={busy || server.status !== 'stopped'}
                                onClick={() => runAction(server.id, () => startServer(server.id), '已启动')}
                              >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                                启动
                              </Button>
                            ) : null}
                            {canAdmin && installing ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                disabled={busy}
                                title="终止安装"
                                onClick={() => runAction(server.id, () => cancelInstall(server.id), '已终止安装')}
                              >
                                <Ban className="h-4 w-4" />
                              </Button>
                            ) : null}
                            {canAdmin && (server.status === 'error' || server.status === 'new_setup') ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                disabled={busy}
                                title="重试安装"
                                onClick={() => runAction(server.id, () => reinstallServer(server.id), '已开始重新安装')}
                              >
                                <Download className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </PageSurface>
      )}

      <CreateServerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false)
          refresh()
        }}
      />

      <EditServerDialog
        server={editServer}
        onClose={() => setEditServer(null)}
        onSaved={() => {
          setEditServer(null)
          refresh()
        }}
        onDeleted={() => {
          setEditServer(null)
          refresh()
        }}
      />

      <ServerConsoleDialog
        server={
          consoleServer ? data?.find((s) => s.id === consoleServer.id) ?? consoleServer : null
        }
        onClose={() => setConsoleServer(null)}
        onChanged={refresh}
      />
    </PageShell>
  )
}

function JavaHintText({ info }: { info: JavaInfo }) {
  return (
    <span
      className={cn(
        'min-w-0 truncate text-right text-xs',
        info.satisfied ? 'text-muted-foreground' : 'text-destructive',
      )}
    >
      {info.required_major ? `需要 Java ${info.required_major}+` : '所需 Java 版本未知'}
      {info.satisfied
        ? info.chosen_major
          ? ` · 将使用 Java ${info.chosen_major}`
          : ' · 将使用默认 Java'
        : ` · ${info.message ?? '没有满足要求的 Java'}`}
    </span>
  )
}

function CreateServerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const { showToast } = useGlobalToast()
  const [name, setName] = useState('')
  const [type, setType] = useState<ServerType>('vanilla')
  const [channel, setChannel] = useState<VersionChannel>('release')
  const [mcVersion, setMcVersion] = useState('')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [mcVersions, setMcVersions] = useState<string[]>([])
  const [loaders, setLoaders] = useState<string[]>([])
  const [mcLoading, setMcLoading] = useState(false)
  const [loaderLoading, setLoaderLoading] = useState(false)
  const [minMemory, setMinMemory] = useState('1G')
  const [maxMemory, setMaxMemory] = useState('2G')
  const [port, setPort] = useState('25565')
  const [submitting, setSubmitting] = useState(false)
  const [javaInfo, setJavaInfo] = useState<JavaInfo | null>(null)

  const needsMc = type !== 'velocity'
  const needsLoader = type !== 'vanilla'
  const showChannel = type === 'vanilla' || type === 'fabric'

  useEffect(() => {
    if (open) {
      setName('')
      setType('vanilla')
      setChannel('release')
    }
  }, [open])

  const loadMc = (force = false) => {
    setMcLoading(true)
    getServerVersions(type, channel, force)
      .then((list) => {
        setMcVersions(list)
        setMcVersion(list[0] ?? '')
      })
      .catch((err) => showToast('error', err instanceof ApiError ? err.message : '获取版本失败'))
      .finally(() => setMcLoading(false))
  }

  // MC/游戏版本(velocity 无需);类型/频道变化时重拉
  useEffect(() => {
    if (!open) return
    if (!needsMc) {
      setMcVersions([])
      setMcVersion('')
      return
    }
    loadMc()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type, channel])

  const loadLoaders = (force = false) => {
    setLoaderLoading(true)
    getLoaderVersions(type, type === 'velocity' ? '' : mcVersion, force)
      .then((list) => {
        setLoaders(list)
        setLoaderVersion(list[0] ?? '')
      })
      .catch((err) => showToast('error', err instanceof ApiError ? err.message : '获取加载器版本失败'))
      .finally(() => setLoaderLoading(false))
  }

  // 加载器/核心版本:velocity 直接列;fabric/forge 依赖 mcVersion
  useEffect(() => {
    if (!open || !needsLoader) {
      setLoaders([])
      setLoaderVersion('')
      return
    }
    if (type !== 'velocity' && !mcVersion) {
      setLoaders([])
      setLoaderVersion('')
      return
    }
    loadLoaders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type, mcVersion])

  // Java 提示(仅需要 MC 版本时)
  useEffect(() => {
    if (!open || !needsMc || !mcVersion) {
      setJavaInfo(null)
      return
    }
    let cancelled = false
    getJavaInfo(mcVersion)
      .then((info) => !cancelled && setJavaInfo(info))
      .catch(() => !cancelled && setJavaInfo(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mcVersion, type])

  const submit = async () => {
    if (!name.trim()) {
      showToast('error', '请填写名称')
      return
    }
    if (needsMc && !mcVersion) {
      showToast('error', '请选择版本')
      return
    }
    if (needsLoader && !loaderVersion) {
      showToast('error', '请选择加载器/核心版本')
      return
    }
    setSubmitting(true)
    try {
      await createServer({
        name: name.trim(),
        server_type: type,
        mc_version: needsMc ? mcVersion : '',
        loader_version: needsLoader ? loaderVersion : '',
        min_memory: minMemory.trim() || '1G',
        max_memory: maxMemory.trim() || '2G',
        port: Number(port) || 25565,
      })
      showToast('success', '已创建,正在后台安装核心')
      onCreated()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const loaderLabel =
    type === 'forge' ? 'Forge 版本' : type === 'fabric' ? 'Fabric Loader 版本' : 'Velocity 版本'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建服务器</DialogTitle>
          <DialogDescription>核心将在后台自动下载/安装(Forge 会运行官方安装器,耗时较长)。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="srv-name">名称</Label>
            <Input id="srv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 survival" autoFocus />
          </div>

          <div className="space-y-2">
            <Label>类型</Label>
            <Select value={type} onValueChange={(v) => setType(v as ServerType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="vanilla">原版 Vanilla</SelectItem>
                <SelectItem value="fabric">Fabric</SelectItem>
                <SelectItem value="forge">Forge</SelectItem>
                <SelectItem value="velocity">Velocity(代理端)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {needsMc ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="srv-version" className="shrink-0">Minecraft 版本</Label>
                {javaInfo ? <JavaHintText info={javaInfo} /> : null}
              </div>
              <div className="flex items-center gap-2">
                {showChannel ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-20 shrink-0"
                    title="切换版本频道"
                    onClick={() =>
                      setChannel((c) => (c === 'release' ? 'snapshot' : c === 'snapshot' ? 'experimental' : 'release'))
                    }
                  >
                    {CHANNEL_LABEL[channel]}
                  </Button>
                ) : null}
                <Select value={mcVersion} onValueChange={setMcVersion} disabled={mcLoading}>
                  <SelectTrigger id="srv-version" className="flex-1">
                    <SelectValue placeholder={mcLoading ? '加载中…' : '选择版本'} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {mcVersions.map((v) => (<SelectItem key={v} value={v}>{v}</SelectItem>))}
                  </SelectContent>
                </Select>
                <Button type="button" variant="outline" size="icon" className="shrink-0" disabled={mcLoading} title="刷新版本列表" onClick={() => loadMc(true)}>
                  <RefreshCw className={cn('h-4 w-4', mcLoading && 'animate-spin')} />
                </Button>
              </div>
            </div>
          ) : null}

          {needsLoader ? (
            <div className="space-y-2">
              <Label>{loaderLabel}</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={loaderVersion}
                  onValueChange={setLoaderVersion}
                  disabled={loaderLoading || (type !== 'velocity' && !mcVersion)}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={loaderLoading ? '加载中…' : '选择版本'} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {loaders.map((v) => (<SelectItem key={v} value={v}>{v}</SelectItem>))}
                  </SelectContent>
                </Select>
                <Button type="button" variant="outline" size="icon" className="shrink-0" disabled={loaderLoading} title="刷新版本列表" onClick={() => loadLoaders(true)}>
                  <RefreshCw className={cn('h-4 w-4', loaderLoading && 'animate-spin')} />
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="srv-min">最小内存</Label>
              <Input id="srv-min" value={minMemory} onChange={(e) => setMinMemory(e.target.value)} placeholder="1G" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="srv-max">最大内存</Label>
              <Input id="srv-max" value={maxMemory} onChange={(e) => setMaxMemory(e.target.value)} placeholder="2G" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="srv-port">端口</Label>
              <Input id="srv-port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="25565" inputMode="numeric" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="button" className="gap-2" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const DIFFICULTY_OPTIONS = ['peaceful', 'easy', 'normal', 'hard']
const GAMEMODE_OPTIONS = ['survival', 'creative', 'adventure', 'spectator']
const JAVA_AUTO = '__auto__'

function PropSwitch({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border border-border/70 px-3 py-2">
      <span className="text-sm">{label}</span>
      <Switch checked={value === 'true'} onCheckedChange={(c) => onChange(c ? 'true' : 'false')} />
    </label>
  )
}

function EditServerDialog({
  server,
  onClose,
  onSaved,
  onDeleted,
}: {
  server: ServerSummary | null
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const { showToast } = useGlobalToast()
  const [tab, setTab] = useState('basic')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [minMemory, setMinMemory] = useState('1G')
  const [maxMemory, setMaxMemory] = useState('2G')
  const [port, setPort] = useState('25565')
  const [extraJvm, setExtraJvm] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [protectedFlag, setProtectedFlag] = useState(false)
  const [javaOverride, setJavaOverride] = useState('')
  const [props, setProps] = useState<Record<string, string>>({})
  const [velCfg, setVelCfg] = useState<VelocityConfig>({ motd: '', show_max_players: 500, online_mode: true, forwarding_mode: 'NONE' })
  const [versions, setVersions] = useState<string[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [javaInfo, setJavaInfo] = useState<JavaInfo | null>(null)
  const [javaInstalls, setJavaInstalls] = useState<JavaInstall[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const open = server !== null
  const running = server?.status === 'running' || server?.status === 'starting'
  // 实例当前是否受保护(以服务器现状为准):锁定其它编辑与删除
  const locked = server?.protected ?? false
  // 仅原版支持在编辑里换版本;其它类型版本/核心只读(改核心请重建实例)
  const isVanilla = server?.server_type === 'vanilla'
  const isVelocity = server?.server_type === 'velocity'

  useEffect(() => {
    if (!server) return
    setTab('basic')
    setName(server.name)
    setVersion(server.mc_version)
    setMinMemory(server.min_memory)
    setMaxMemory(server.max_memory)
    setPort(String(server.port))
    setExtraJvm(server.extra_jvm_args)
    setAutoStart(server.auto_start)
    setProtectedFlag(server.protected)
    setJavaOverride(server.java_path_override)
    // 仅在打开/切换实例时初始化,避免列表刷新覆盖正在编辑的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id])

  useEffect(() => {
    if (!open || !server) return
    if (isVanilla) {
      setVersionsLoading(true)
      getServerVersions('vanilla')
        .then(setVersions)
        .catch(() => undefined)
        .finally(() => setVersionsLoading(false))
    }
    if (isVelocity) {
      getVelocityConfig(server.id).then(setVelCfg).catch(() => undefined)
    } else {
      getProperties(server.id).then(setProps).catch(() => setProps({}))
    }
    getSettings()
      .then((s) => setJavaInstalls(s.java_installs))
      .catch(() => setJavaInstalls([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.id])

  useEffect(() => {
    if (!open || !version) {
      setJavaInfo(null)
      return
    }
    let cancelled = false
    getJavaInfo(version)
      .then((info) => !cancelled && setJavaInfo(info))
      .catch(() => !cancelled && setJavaInfo(null))
    return () => {
      cancelled = true
    }
  }, [open, version])

  const refreshVersions = async () => {
    setVersionsLoading(true)
    try {
      setVersions(await getServerVersions('vanilla', 'release', true))
      showToast('success', '版本列表已刷新')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '刷新失败')
    } finally {
      setVersionsLoading(false)
    }
  }

  const setProp = (key: string, value: string) => setProps((p) => ({ ...p, [key]: value }))

  const doDelete = async () => {
    if (!server) return
    if (!window.confirm(`确定删除服务器「${server.name}」?该实例的所有文件将被移除,且不可恢复。`)) return
    setDeleting(true)
    try {
      await deleteServer(server.id)
      showToast('success', '已删除')
      onDeleted()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const submit = async () => {
    if (!server) return
    // 受保护:本次只取消保护,不应用其它字段(与后端一致)
    if (locked) {
      setSubmitting(true)
      try {
        await updateServer(server.id, { protected: false })
        showToast('success', '已取消保护')
        onSaved()
      } catch (err) {
        showToast('error', err instanceof ApiError ? err.message : '操作失败')
      } finally {
        setSubmitting(false)
      }
      return
    }
    if (!name.trim()) {
      showToast('error', '名称不能为空')
      return
    }
    setSubmitting(true)
    try {
      await updateServer(server.id, {
        name: name.trim(),
        min_memory: minMemory.trim() || '1G',
        max_memory: maxMemory.trim() || '2G',
        port: Number(port) || 25565,
        mc_version: version,
        extra_jvm_args: extraJvm,
        auto_start: autoStart,
        java_path_override: javaOverride,
        protected: protectedFlag,
      })
      if (isVelocity) {
        await updateVelocityConfig(server.id, velCfg)
      } else {
        const toWrite = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== ''))
        await updateProperties(server.id, toWrite)
      }
      showToast('success', version !== server.mc_version ? '已保存,正在重新下载核心' : '已保存')
      onSaved()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>编辑实例 —— {server?.name}</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="basic">基本</TabsTrigger>
            <TabsTrigger value="properties">{isVelocity ? 'Velocity 配置' : '服务器属性'}</TabsTrigger>
            <TabsTrigger value="advanced">高级</TabsTrigger>
          </TabsList>

          {/* 基本 */}
          <TabsContent value="basic" className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">名称</Label>
              <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {isVanilla ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="edit-version" className="shrink-0">Minecraft 版本</Label>
                  {running ? (
                    <span className="min-w-0 truncate text-right text-xs text-muted-foreground">运行中不可更换版本,请先停止</span>
                  ) : javaInfo ? (
                    <JavaHintText info={javaInfo} />
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Select value={version} onValueChange={setVersion} disabled={versionsLoading || running}>
                    <SelectTrigger id="edit-version" className="flex-1">
                      <SelectValue placeholder={versionsLoading ? '加载中…' : '选择版本'} />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {version && !versions.includes(version) ? (
                        <SelectItem value={version}>{version}(当前)</SelectItem>
                      ) : null}
                      {versions.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    disabled={versionsLoading}
                    title="刷新版本列表"
                    onClick={refreshVersions}
                  >
                    <RefreshCw className={cn('h-4 w-4', versionsLoading && 'animate-spin')} />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>类型 / 版本</Label>
                <div className="rounded-md border border-border/70 px-3 py-2 text-sm text-muted-foreground">
                  {TYPE_LABEL[server?.server_type ?? ''] ?? server?.server_type}
                  {server?.mc_version ? ` · MC ${server.mc_version}` : ''}
                  {server?.loader_version ? ` · ${server.loader_version}` : ''}
                  <span className="block text-xs">更换核心版本请重建实例</span>
                </div>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="edit-min">最小内存</Label>
                <Input id="edit-min" value={minMemory} onChange={(e) => setMinMemory(e.target.value)} placeholder="1G" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-max">最大内存</Label>
                <Input id="edit-max" value={maxMemory} onChange={(e) => setMaxMemory(e.target.value)} placeholder="2G" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-port">端口</Label>
                <Input id="edit-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
              </div>
            </div>
          </TabsContent>

          {/* 服务器属性 / Velocity 配置 */}
          <TabsContent value="properties" className="space-y-4 py-2">
            {isVelocity ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="vel-motd">MOTD</Label>
                  <Input id="vel-motd" value={velCfg.motd} onChange={(e) => setVelCfg((c) => ({ ...c, motd: e.target.value }))} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="vel-max">最大显示玩家数</Label>
                    <Input id="vel-max" value={String(velCfg.show_max_players)} inputMode="numeric" onChange={(e) => setVelCfg((c) => ({ ...c, show_max_players: Number(e.target.value) || 0 }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>玩家信息转发模式</Label>
                    <Select value={velCfg.forwarding_mode} onValueChange={(v) => setVelCfg((c) => ({ ...c, forwarding_mode: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">NONE</SelectItem>
                        <SelectItem value="LEGACY">LEGACY(BungeeCord)</SelectItem>
                        <SelectItem value="BUNGEEGUARD">BUNGEEGUARD</SelectItem>
                        <SelectItem value="MODERN">MODERN(Velocity)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <label className="flex items-center justify-between gap-4 rounded-md border border-border/70 px-3 py-2.5">
                  <span className="text-sm font-medium">在线模式(正版验证)</span>
                  <Switch checked={velCfg.online_mode} onCheckedChange={(v) => setVelCfg((c) => ({ ...c, online_mode: v }))} />
                </label>
                <p className="text-xs text-muted-foreground">改动保存后,重启 Velocity 生效。后端服务器请在「高级」或直接编辑 velocity.toml 配置。</p>
              </>
            ) : (
            <>
            <div className="space-y-2">
              <Label htmlFor="prop-motd">服务器描述 (MOTD)</Label>
              <Input id="prop-motd" value={props['motd'] ?? ''} onChange={(e) => setProp('motd', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="prop-max">最大玩家数</Label>
                <Input id="prop-max" value={props['max-players'] ?? ''} onChange={(e) => setProp('max-players', e.target.value)} inputMode="numeric" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prop-view">视距</Label>
                <Input id="prop-view" value={props['view-distance'] ?? ''} onChange={(e) => setProp('view-distance', e.target.value)} inputMode="numeric" />
              </div>
              <div className="space-y-2">
                <Label>难度</Label>
                <Select value={props['difficulty'] ?? ''} onValueChange={(v) => setProp('difficulty', v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="默认" />
                  </SelectTrigger>
                  <SelectContent>
                    {DIFFICULTY_OPTIONS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>游戏模式</Label>
                <Select value={props['gamemode'] ?? ''} onValueChange={(v) => setProp('gamemode', v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="默认" />
                  </SelectTrigger>
                  <SelectContent>
                    {GAMEMODE_OPTIONS.map((g) => (
                      <SelectItem key={g} value={g}>
                        {g}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="prop-seed">世界种子</Label>
              <Input id="prop-seed" value={props['level-seed'] ?? ''} onChange={(e) => setProp('level-seed', e.target.value)} placeholder="留空随机;仅对新世界生效" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <PropSwitch label="正版验证" value={props['online-mode'] ?? ''} onChange={(v) => setProp('online-mode', v)} />
              <PropSwitch label="白名单" value={props['white-list'] ?? ''} onChange={(v) => setProp('white-list', v)} />
              <PropSwitch label="PVP" value={props['pvp'] ?? ''} onChange={(v) => setProp('pvp', v)} />
            </div>
            </>
            )}
          </TabsContent>

          {/* 高级 */}
          <TabsContent value="advanced" className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-jvm">额外 JVM 参数</Label>
              <Textarea
                id="edit-jvm"
                value={extraJvm}
                onChange={(e) => setExtraJvm(e.target.value)}
                rows={2}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>指定 Java</Label>
              <Select
                value={javaOverride || JAVA_AUTO}
                onValueChange={(v) => setJavaOverride(v === JAVA_AUTO ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={JAVA_AUTO}>自动(按版本选择)</SelectItem>
                  {javaOverride && !javaInstalls.some((i) => i.path === javaOverride) ? (
                    <SelectItem value={javaOverride}>{javaOverride}</SelectItem>
                  ) : null}
                  {javaInstalls.map((i) => (
                    <SelectItem key={i.path} value={i.path}>
                      {i.major ? `Java ${i.major} — ` : ''}
                      {i.path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-md border border-border/70 px-3 py-2.5">
              <span>
                <span className="block text-sm font-medium">开机自启</span>
                <span className="block text-xs text-muted-foreground">面板启动时自动拉起该实例</span>
              </span>
              <Switch checked={autoStart} onCheckedChange={setAutoStart} />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
              <span>
                <span className="block text-sm font-medium">保护实例</span>
                <span className="block text-xs text-muted-foreground">开启后仅管理员可停止;编辑/删除/插件/模组/超平坦/恢复到本服 全部禁止</span>
              </span>
              <Switch checked={protectedFlag} onCheckedChange={setProtectedFlag} />
            </label>
            <div className="flex items-center justify-between gap-4 rounded-md border border-destructive/30 px-3 py-2.5">
              <span>
                <span className="block text-sm font-medium text-destructive">删除实例</span>
                <span className="block text-xs text-muted-foreground">移除该实例的所有文件,不可恢复</span>
              </span>
              <Button type="button" variant="outline" size="sm" className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={locked || deleting} onClick={doDelete}>
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                删除
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        {locked ? (
          <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            实例受保护:请在「高级」里关闭「保护实例」并保存后,才能编辑其它项或删除。
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="button" className="gap-2" onClick={submit} disabled={submitting || (locked && protectedFlag)}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
            {locked ? '取消保护' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
