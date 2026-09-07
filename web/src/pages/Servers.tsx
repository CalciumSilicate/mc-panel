import { useEffect, useMemo, useRef, useState } from 'react'
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { Ban, ChevronDown, ChevronUp, Download, FolderOpen, GripVertical, Loader2, MessageSquare, Network, Pencil, Plus, RefreshCw, Server, Terminal, Trash2, X } from 'lucide-react'

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
  getSuggestedPort,
  getVelocityConfig,
  listServers,
  reorderServers,
  reinstallServer,
  getRconInfo,
  type RconInfo,
  setRcon,
  updateProperties,
  updateServer,
  previewStartCommand,
  updateVelocityConfig,
} from '@/api/servers'
import { type JavaInstall, getSettings } from '@/api/settings'
import { type ServerGroup, createGroup, deleteGroup, listGroups, updateGroup } from '@/api/groups'
import { useAuth } from '@/components/auth-context'
import { useConfirm, usePrompt } from '@/components/ui/dialog-context'
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
import { ServerFilesDialog } from '@/components/ServerFilesDialog'
import { ServerLifecycleButton } from '@/components/ServerLifecycleButton'
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

// 类型 badge 配色:各类型一眼可辨(明暗两套)
const TYPE_BADGE: Record<string, string> = {
  vanilla: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  fabric: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  forge: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  velocity: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
}

const CHANNEL_LABEL: Record<VersionChannel, string> = {
  release: '正式版',
  snapshot: '快照版',
  experimental: '实验版',
}

function SortableServerRow({ server, canSort, disabled, children }: {
  server: ServerSummary
  canSort: boolean
  disabled: boolean
  children: ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: server.id,
    disabled: !canSort || disabled,
    transition: { duration: reducedMotion ? 0 : 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  })

  return (
    <TableRow
      ref={setNodeRef}
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Transform.toString(transform), transition, position: 'relative', zIndex: isDragging ? 10 : undefined }}
      className={cn(isDragging && 'bg-card shadow-xl ring-1 ring-primary/50 hover:bg-card [&_td]:bg-primary/10')}
    >
      <TableCell className="w-8 px-1">
        {canSort ? (
          <button
            ref={setActivatorNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            disabled={disabled}
            aria-label={`调整 ${server.name} 的位置`}
            title="拖拽排序；也可按空格选中、方向键移动、空格放下、Esc 取消"
            className={cn('flex h-8 w-7 touch-none select-none items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait', isDragging ? 'cursor-grabbing text-primary' : 'cursor-grab')}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        ) : null}
      </TableCell>
      {children}
    </TableRow>
  )
}

function ServerQuickEdit({ server, field, groups, editable, onSaved }: {
  server: ServerSummary
  field: 'group' | 'memory' | 'port' | 'priority' | 'auto'
  groups: ServerGroup[]
  editable: boolean
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [group, setGroup] = useState('none')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [port, setPort] = useState('')
  const [saved, setSaved] = useState<ServerSummary | null>(null)
  const saving = useRef(false)
  const { showToast } = useGlobalToast()
  const label = { group: '互联组', memory: '内存', port: '端口', priority: '自启优先级', auto: '开机自启' }[field]
  const current = saved ?? server
  const value = field === 'group' ? current.group_name || '—' : field === 'memory' ? `${current.min_memory} ~ ${current.max_memory}` : field === 'priority' ? String(current.autostart_priority ?? 0) : field === 'auto' ? (current.auto_start ? '已开启' : '已关闭') : String(current.port)
  const locked = !editable || server.protected || server.status === 'installing'

  // Keep the acknowledged value visible until polling catches up, including
  // when an already in-flight list request returns the pre-save snapshot.
  useEffect(() => {
    if (!saved) return
    const caughtUp = field === 'memory' ? server.min_memory === saved.min_memory && server.max_memory === saved.max_memory
      : field === 'group' ? server.group_id === saved.group_id
      : field === 'priority' ? server.autostart_priority === saved.autostart_priority
      : field === 'auto' ? server.auto_start === saved.auto_start : server.port === saved.port
    if (caughtUp) setSaved(null)
  }, [server, saved, field])

  const changeOpen = (next: boolean) => {
    if (saving.current) return
    if (next) {
      setGroup(current.group_id === null ? 'none' : String(current.group_id))
      setMin(current.min_memory)
      setMax(current.max_memory)
      setPort(field === 'priority' ? String(current.autostart_priority ?? 0) : String(current.port))
      setError('')
    }
    setOpen(next)
  }

  const save = async (selectedGroup = group) => {
    if (saving.current || locked) return
    const low = min.trim().toUpperCase()
    const high = max.trim().toUpperCase()
    if (field === 'memory') {
      const memory = (v: string) => {
        const match = /^([1-9]\d*)([KMG]?)$/.exec(v)
        return match ? Number(match[1]) * (1024 ** (match[2] ? 'KMG'.indexOf(match[2]) + 1 : 0)) : NaN
      }
      if (!Number.isFinite(memory(low)) || !Number.isFinite(memory(high)) || memory(low) > memory(high)) {
        setError('请输入有效内存（如 512M、2G），且最小内存不能大于最大内存。')
        return
      }
    }
    if (field === 'port' && (!/^\d+$/.test(port.trim()) || Number(port) < 1 || Number(port) > 65535)) {
      setError('端口须为 1–65535 的整数。')
      return
    }
    if (field === 'priority' && (!/^-?\d+$/.test(port.trim()) || !Number.isSafeInteger(Number(port)))) {
      setError('优先级须为整数，数值越小越先启动。')
      return
    }
    saving.current = true
    setBusy(true)
    setError('')
    try {
      const updated = await updateServer(server.id, field === 'group' ? { group_id: selectedGroup === 'none' ? null : Number(selectedGroup) } : field === 'memory' ? { min_memory: low, max_memory: high } : field === 'priority' ? { autostart_priority: Number(port) } : field === 'auto' ? { auto_start: !current.auto_start } : { port: Number(port) })
      setSaved(updated)
      setOpen(false)
      showToast('success', `${label}已保存`)
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  if (locked) return <span title={server.protected ? '实例受保护，请先取消保护' : undefined}>{value}</span>

  if (!open || field === 'auto') return (
    <span className="inline-flex w-max max-w-full flex-col">
      <button type="button" disabled={busy} aria-label={`修改 ${server.name} 的${label}`} aria-pressed={field === 'auto' ? current.auto_start : undefined} title={`点击修改${label}`} onClick={() => field === 'auto' ? void save() : changeOpen(true)} className={cn('inline-flex w-max shrink-0 items-center whitespace-nowrap rounded px-1 py-1 -mx-1 text-left transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', field === 'auto' && current.auto_start && 'text-primary')}>
        {value}
        {busy ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
      </button>
      {error ? <span role="alert" className="whitespace-normal text-xs text-destructive">{error}</span> : null}
    </span>
  )

  return (
        <form aria-label={`修改${label}`} title="Enter 或移出输入框保存，Esc 取消" className="relative w-max font-sans"
          onBlur={(e) => { if (field !== 'group' && !e.currentTarget.contains(e.relatedTarget)) void save() }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); changeOpen(false) }
            if (e.key === 'Enter' && field !== 'group' && !e.nativeEvent.isComposing) { e.preventDefault(); void save() }
          }}
          onSubmit={(e) => { e.preventDefault(); void save() }}>
          <fieldset disabled={busy} className="flex items-center gap-1">
            {field === 'group' ? (
              <Select value={group} onValueChange={(next) => { setGroup(next); void save(next) }} disabled={busy}>
                <SelectTrigger autoFocus aria-label="互联组" className="h-8 w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不加入互联组</SelectItem>
                  {groups.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : field === 'memory' ? (
              <div className="flex items-center gap-1">
                <Input autoFocus aria-label="最小内存" title="最小内存" className="h-8 w-[7ch] px-1.5" value={min} onChange={(e) => setMin(e.target.value)} placeholder="512M" />
                <span aria-hidden="true">~</span>
                <Input aria-label="最大内存" title="最大内存" className="h-8 w-[7ch] px-1.5" value={max} onChange={(e) => setMax(e.target.value)} placeholder="2G" />
              </div>
            ) : <Input autoFocus aria-label={label} className="h-8 w-[8ch] px-1.5" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />}
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          </fieldset>
          {error ? <p role="alert" className="max-w-48 whitespace-normal text-xs text-destructive">{error}</p> : null}
        </form>
  )
}

/**
 * 服务器实例 —— 列表 + 新建(vanilla/fabric/forge/velocity)+ 启停/删除。
 * 列表每 4s 自动刷新一次,以便反映「安装中 → 已停止」的状态变化。
 */
export default function Servers() {
  const { roleAtLeast } = useAuth()
  const canAdmin = roleAtLeast('admin')
  const canHelper = roleAtLeast('helper')
  const { data, loading, error, refresh } = useResource(() => listServers(), [])
  const { data: groups, refresh: refreshGroups } = useResource(() => listGroups(), [])
  const { showToast } = useGlobalToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [consoleServer, setConsoleServer] = useState<ServerSummary | null>(null)
  const [filesServer, setFilesServer] = useState<ServerSummary | null>(null)
  const [editServer, setEditServer] = useState<ServerSummary | null>(null)
  const [commandsServer, setCommandsServer] = useState<ServerSummary | null>(null)
  const [commandsDraft, setCommandsDraft] = useState('')
  const [commandsBusy, setCommandsBusy] = useState(false)
  // 拖拽排序:localOrder 为乐观顺序(拖完立即生效,后台持久化);null=用后端返回顺序
  const [localOrder, setLocalOrder] = useState<number[] | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)
  const [sort, setSort] = useState<{ key: keyof ServerSummary; direction: 1 | -1 } | null>(null)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const displayed = useMemo(() => {
    const list = data ?? []
    const byId = new Map(list.map((s) => [s.id, s]))
    const ordered = (localOrder ?? list.map((s) => s.id)).map((id) => byId.get(id)).filter(Boolean) as ServerSummary[]
    // localOrder 里没有的(新建 / 其它来源)追加到末尾
    for (const s of list) if (localOrder && !localOrder.includes(s.id)) ordered.push(s)
    if (sort) ordered.sort((a, b) => {
      const left = a[sort.key] ?? 0
      const right = b[sort.key] ?? 0
      if (sort.key === 'max_memory') {
        const size = (v: unknown) => { const m = /^(\d+)([KMG]?)$/i.exec(String(v)); return m ? Number(m[1]) * 1024 ** (m[2] ? 'KMG'.indexOf(m[2].toUpperCase()) + 1 : 0) : 0 }
        return (size(left) - size(right)) * sort.direction
      }
      return (typeof left === 'number' || typeof left === 'boolean' ? Number(left) - Number(right) : String(left).localeCompare(String(right), 'zh-CN', { numeric: true })) * sort.direction
    })
    return ordered
  }, [data, localOrder, sort])

  const persistOrder = async (ids: number[]) => {
    setLocalOrder(ids)
    setSavingOrder(true)
    try {
      await reorderServers(ids)
    } catch (err) {
      setLocalOrder(null)
      showToast('error', err instanceof ApiError ? err.message : '排序保存失败')
    } finally {
      setSavingOrder(false)
      refresh()
    }
  }

  const handleDrop = ({ active, over }: DragEndEvent) => {
    setDragId(null)
    if (!over || active.id === over.id) return
    const ids = displayed.map((s) => s.id)
    const from = ids.indexOf(Number(active.id))
    const to = ids.indexOf(Number(over.id))
    if (from === -1 || to === -1) return
    void persistOrder(arrayMove(ids, from, to))
  }

  useEffect(() => {
    if (dragId !== null || savingOrder) return
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh, dragId, savingOrder])

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
      width="full"
      actions={
        <>
          <Button type="button" variant="outline" className="gap-2 px-3 sm:px-4" title="刷新" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            <span className="sr-only sm:not-sr-only">刷新</span>
          </Button>
          {canAdmin ? (
            <Button type="button" variant="outline" className="gap-2 px-3 sm:px-4" title="互联组" onClick={() => setManageGroupsOpen(true)}>
              <Network className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">互联组</span>
            </Button>
          ) : null}
          {canAdmin ? (
            <Button type="button" className="gap-2" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="sm:hidden">新建</span><span className="hidden sm:inline">新建服务器</span>
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
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[({ transform, draggingNodeRect, containerNodeRect }) => ({
                  ...transform,
                  x: 0,
                  // The row's parent is tbody: exclude the header and keep
                  // the entire dragged row inside the first/last data rows.
                  y: draggingNodeRect && containerNodeRect
                    ? Math.min(
                      Math.max(transform.y, containerNodeRect.top - draggingNodeRect.top),
                      containerNodeRect.bottom - draggingNodeRect.bottom,
                    )
                    : transform.y,
                })]}
                onDragStart={({ active }) => setDragId(Number(active.id))}
                onDragCancel={() => setDragId(null)}
                onDragEnd={handleDrop}
              >
              <SortableContext items={displayed.map((server) => server.id)} strategy={verticalListSortingStrategy}>
              <Table className="min-w-[1300px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8 px-1" />
                    {([
                      ['名称', 'name'], ['类型', 'server_type'], ['版本', 'mc_version'], ['加载器/核心', 'loader_version'],
                      ['互联组', 'group_name'], ['内存', 'max_memory'], ['端口', 'port'], ['开机自启', 'auto_start'], ['自启优先级', 'autostart_priority'], ['状态', 'status'],
                    ] as const).map(([label, key]) => (
                      <TableHead key={key} aria-sort={sort?.key === key ? sort.direction === 1 ? 'ascending' : 'descending' : 'none'}>
                        <button type="button" disabled={dragId !== null} className="inline-flex items-center gap-1 hover:text-foreground" title="点击切换升序、降序、原始顺序；排序时暂停拖拽" onClick={() => setSort(sort?.key !== key ? { key, direction: 1 } : sort.direction === 1 ? { key, direction: -1 } : null)}>
                          {label}{sort?.key === key ? sort.direction === 1 ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" /> : null}
                        </button>
                      </TableHead>
                    ))}
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayed.map((server) => {
                    const meta = SERVER_STATUS_META[server.status]
                    const busy = busyId === server.id
                    const installing = server.status === 'installing'
                    const starting = server.status === 'starting'
                    return (
                      <SortableServerRow
                        key={server.id}
                        server={server}
                        canSort={canAdmin}
                        disabled={savingOrder || sort !== null}
                      >
                        <TableCell className="max-w-52 truncate font-medium" title={server.name}>{server.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-[11px]', TYPE_BADGE[server.server_type])}>{TYPE_LABEL[server.server_type] ?? server.server_type}</Badge>
                        </TableCell>
                        <TableCell className="max-w-40 truncate text-muted-foreground" title={server.mc_version}>{server.mc_version || '—'}</TableCell>
                        <TableCell className="max-w-52 truncate font-mono text-xs text-muted-foreground" title={server.loader_version}>{server.loader_version || '—'}</TableCell>
                        <TableCell className="text-muted-foreground">
                          <ServerQuickEdit server={server} field="group" groups={groups ?? []} editable={canAdmin} onSaved={refresh} />
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          <ServerQuickEdit server={server} field="memory" groups={groups ?? []} editable={canAdmin} onSaved={refresh} />
                        </TableCell>
                        <TableCell className="font-mono text-muted-foreground">
                          <ServerQuickEdit server={server} field="port" groups={groups ?? []} editable={canAdmin} onSaved={refresh} />
                        </TableCell>
                        <TableCell>
                          <ServerQuickEdit server={server} field="auto" groups={groups ?? []} editable={canAdmin} onSaved={refresh} />
                        </TableCell>
                        <TableCell>
                          <ServerQuickEdit server={server} field="priority" groups={groups ?? []} editable={canAdmin} onSaved={refresh} />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="outline" className={cn('gap-1 text-[11px]', meta.tone)}>
                              {installing || starting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                              {meta.label}
                              {installing && server.install ? ` ${server.install.percent}%` : ''}
                            </Badge>
                            {server.needs_restart ? (
                              <Badge variant="outline" className="gap-1 text-[11px] text-amber-600 dark:text-amber-400 border-amber-500/50">需要重启</Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1.5">
                            {canAdmin ? <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="浏览服务器文件" aria-label="浏览服务器文件" onClick={() => setFilesServer(server)}><FolderOpen className="h-4 w-4" /></Button> : null}
                            {canAdmin ? <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="编辑开服自动执行指令" aria-label="编辑开服自动执行指令" disabled={server.protected || installing} onClick={() => { setCommandsServer(server); setCommandsDraft((server.startup_commands ?? []).join('\n')) }}><MessageSquare className="h-4 w-4" /></Button> : null}
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
                            <ServerLifecycleButton server={server} onChanged={refresh} />
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
                      </SortableServerRow>
                    )
                  })}
                </TableBody>
              </Table>
              </SortableContext>
              </DndContext>
            </div>
          )}
        </PageSurface>
      )}

      <CreateServerDialog
        open={createOpen}
        groups={groups ?? []}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false)
          refresh()
        }}
      />

      <Dialog open={commandsServer !== null} onOpenChange={(open) => { if (!open && !commandsBusy) setCommandsServer(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>开服自动执行指令 · {commandsServer?.name}</DialogTitle><DialogDescription>每行一条，实例加载完成（Done）后依次执行；不会立即执行。</DialogDescription></DialogHeader>
          <Textarea aria-label="开服自动执行指令" rows={8} value={commandsDraft} disabled={commandsBusy} onChange={(e) => setCommandsDraft(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" disabled={commandsBusy} onClick={() => setCommandsServer(null)}>取消</Button>
            <Button disabled={commandsBusy} onClick={async () => {
              if (!commandsServer) return
              setCommandsBusy(true)
              try {
                await updateServer(commandsServer.id, { startup_commands: commandsDraft.split('\n').map((s) => s.trim()).filter(Boolean) })
                setCommandsServer(null)
                refresh()
                showToast('success', '开服指令已保存')
              } catch (err) { showToast('error', err instanceof ApiError ? err.message : '保存失败') }
              finally { setCommandsBusy(false) }
            }}>{commandsBusy ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EditServerDialog
        server={editServer}
        groups={groups ?? []}
        onClose={() => setEditServer(null)}
        onSaved={() => {
          setEditServer(null)
          refresh()
        }}
        onDeleted={() => {
          setEditServer(null)
          refresh()
        }}
        onChanged={refresh}
      />

      <ManageGroupsDialog
        open={manageGroupsOpen}
        onClose={() => setManageGroupsOpen(false)}
        onChanged={() => {
          refreshGroups()
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
      {filesServer && canAdmin ? <ServerFilesDialog key={filesServer.id}
        server={data?.find((s) => s.id === filesServer.id) ?? filesServer}
        onClose={() => setFilesServer(null)} /> : null}
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

const NO_GROUP = '__none__'

function CreateServerDialog({
  open,
  groups,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  groups: ServerGroup[]
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const { showToast } = useGlobalToast()
  const [name, setName] = useState('')
  const [type, setType] = useState<ServerType>('vanilla')
  const [groupId, setGroupId] = useState<number | null>(null)
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
      setGroupId(null)
      getSuggestedPort().then((p) => setPort(String(p))).catch(() => undefined)
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
        group_id: groupId,
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

          <div className="space-y-2">
            <Label>互联组(可选)</Label>
            <Select value={groupId === null ? NO_GROUP : String(groupId)} onValueChange={(v) => setGroupId(v === NO_GROUP ? null : Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>不加入</SelectItem>
                {groups.map((g) => (<SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>))}
              </SelectContent>
            </Select>
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
  groups,
  onClose,
  onSaved,
  onDeleted,
  onChanged,
}: {
  server: ServerSummary | null
  groups: ServerGroup[]
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
  onChanged: () => void
}) {
  const confirm = useConfirm()
  const { showToast } = useGlobalToast()
  const [tab, setTab] = useState('basic')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [minMemory, setMinMemory] = useState('1G')
  const [maxMemory, setMaxMemory] = useState('2G')
  const [port, setPort] = useState('25565')
  const [extraJvm, setExtraJvm] = useState('')
  const [protectedFlag, setProtectedFlag] = useState(false)
  const [groupId, setGroupId] = useState<number | null>(null)
  const [javaOverride, setJavaOverride] = useState('')
  const [startCmd, setStartCmd] = useState('')
  const [mcdrLang, setMcdrLang] = useState('')
  const [startupCmds, setStartupCmds] = useState('')
  const [commandPreview, setCommandPreview] = useState('')
  const [commandPreviewError, setCommandPreviewError] = useState('')
  const [props, setProps] = useState<Record<string, string>>({})
  const [velCfg, setVelCfg] = useState<VelocityConfig>({ motd: '', show_max_players: 500, online_mode: true, forwarding_mode: 'NONE', servers: [], try_servers: [] })
  const [versions, setVersions] = useState<string[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [loaders, setLoaders] = useState<string[]>([])
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loaderLoading, setLoaderLoading] = useState(false)
  const [javaInfo, setJavaInfo] = useState<JavaInfo | null>(null)
  const [javaInstalls, setJavaInstalls] = useState<JavaInstall[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [rconBusy, setRconBusy] = useState(false)
  const [rconInfo, setRconInfo] = useState<RconInfo | null>(null)
  const [rconPort, setRconPort] = useState('')
  const [rconPwd, setRconPwd] = useState('')

  const open = server !== null
  const running = server?.status === 'running' || server?.status === 'starting'
  // 实例当前是否受保护(以服务器现状为准):锁定其它编辑与删除
  const locked = server?.protected ?? false
  const editType = (server?.server_type ?? 'vanilla') as ServerType
  const isVelocity = editType === 'velocity'
  const needsMc = editType !== 'velocity'
  const needsLoader = editType !== 'vanilla'

  useEffect(() => {
    if (!server) return
    setTab('basic')
    setName(server.name)
    setVersion(server.mc_version)
    setLoaderVersion(server.loader_version)
    setMinMemory(server.min_memory)
    setMaxMemory(server.max_memory)
    setPort(String(server.port))
    setExtraJvm(server.extra_jvm_args)
    setProtectedFlag(server.protected)
    setGroupId(server.group_id)
    setJavaOverride(server.java_path_override)
    setStartCmd(server.start_command_override ?? '')
    setMcdrLang(server.mcdr_language ?? '')
    setStartupCmds((server.startup_commands ?? []).join('\n'))
    // 仅在打开/切换实例时初始化,避免列表刷新覆盖正在编辑的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id])

  const previewId = server?.id
  useEffect(() => {
    if (!previewId || tab !== 'advanced') return
    let cancelled = false
    setCommandPreview('')
    setCommandPreviewError('')
    const timer = window.setTimeout(() => {
      previewStartCommand(previewId, { min_memory: minMemory.trim() || '1G', max_memory: maxMemory.trim() || '2G', extra_jvm_args: extraJvm, java_path_override: javaOverride })
        .then(({ command }) => { if (!cancelled) setCommandPreview(command.map((arg) => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg).join(' ')) })
        .catch((err) => { if (!cancelled) setCommandPreviewError(err instanceof ApiError ? err.message : '生成命令失败') })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [previewId, tab, minMemory, maxMemory, extraJvm, javaOverride])

  useEffect(() => {
    if (!open || !server) return
    if (needsMc) {
      setVersionsLoading(true)
      getServerVersions(editType)
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
    if (!isVelocity) {
      getRconInfo(server.id)
        .then((r) => { setRconInfo(r); setRconPort(r.port ? String(r.port) : ''); setRconPwd(r.password) })
        .catch(() => setRconInfo(null))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.id])

  // 非原版:加载「加载器/核心」版本列表(velocity 无需 mc;fabric/forge 依赖 version)
  useEffect(() => {
    if (!open || !needsLoader) return
    if (editType !== 'velocity' && !version) return
    setLoaderLoading(true)
    getLoaderVersions(editType, editType === 'velocity' ? '' : version)
      .then((list) => {
        setLoaders(list)
        setLoaderVersion((cur) => (cur && list.includes(cur) ? cur : list[0] ?? ''))
      })
      .catch(() => undefined)
      .finally(() => setLoaderLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version, editType])

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
      setVersions(await getServerVersions(editType, 'release', true))
      showToast('success', '版本列表已刷新')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '刷新失败')
    } finally {
      setVersionsLoading(false)
    }
  }

  const refreshLoaders = async () => {
    setLoaderLoading(true)
    try {
      const list = await getLoaderVersions(editType, editType === 'velocity' ? '' : version, true)
      setLoaders(list)
      setLoaderVersion((cur) => (cur && list.includes(cur) ? cur : list[0] ?? ''))
      showToast('success', '版本列表已刷新')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '刷新失败')
    } finally {
      setLoaderLoading(false)
    }
  }

  const setProp = (key: string, value: string) => setProps((p) => ({ ...p, [key]: value }))

  const doDelete = async () => {
    if (!server) return
    if (!(await confirm({ title: `删除服务器「${server.name}」?`, description: '该实例的所有文件将被移除,且不可恢复。', confirmText: '删除', destructive: true }))) return
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

  const reloadRcon = async (id: number) => {
    const info = await getRconInfo(id)
    setRconInfo(info); setRconPort(info.port ? String(info.port) : ''); setRconPwd(info.password)
  }

  const doToggleRcon = async (enabled: boolean) => {
    if (!server) return
    setRconBusy(true)
    try {
      await setRcon(server.id, { enabled })
      await reloadRcon(server.id)
      onChanged() // 刷新列表但不关闭对话框
      showToast('success', enabled ? '已启用 RCON,重启实例后生效' : '已关闭 RCON')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setRconBusy(false)
    }
  }

  const applyRcon = async () => {
    if (!server) return
    setRconBusy(true)
    try {
      await setRcon(server.id, { enabled: true, port: Number(rconPort) || undefined, password: rconPwd.trim() || undefined })
      await reloadRcon(server.id)
      onChanged()
      showToast('success', '已更新 RCON,重启实例后生效')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setRconBusy(false)
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
      const coreChanged = version !== server.mc_version || loaderVersion !== server.loader_version
      await updateServer(server.id, {
        name: name.trim(),
        min_memory: minMemory.trim() || '1G',
        max_memory: maxMemory.trim() || '2G',
        port: Number(port) || 25565,
        mc_version: needsMc ? version : '',
        loader_version: needsLoader ? loaderVersion : undefined,
        extra_jvm_args: extraJvm,
        java_path_override: javaOverride,
        protected: protectedFlag,
        group_id: groupId,
        start_command_override: startCmd,
        mcdr_language: mcdrLang,
        startup_commands: startupCmds.split('\n').map((c) => c.trim()).filter(Boolean),
      })
      if (isVelocity) {
        await updateVelocityConfig(server.id, velCfg)
      } else {
        const toWrite = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== ''))
        await updateProperties(server.id, toWrite)
      }
      showToast('success', coreChanged ? '已保存,正在重新安装核心' : '已保存')
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
            <div className="space-y-2">
              <Label>类型</Label>
              <div className="rounded-md border border-border/70 px-3 py-2 text-sm text-muted-foreground">
                {TYPE_LABEL[editType] ?? editType}
              </div>
            </div>
            {needsMc ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="edit-version" className="shrink-0">Minecraft 版本</Label>
                  {running ? (
                    <span className="min-w-0 truncate text-right text-xs text-muted-foreground">运行中不可更换,请先停止</span>
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
                      {versions.map((v) => (<SelectItem key={v} value={v}>{v}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" size="icon" className="shrink-0" disabled={versionsLoading || running} title="刷新版本列表" onClick={refreshVersions}>
                    <RefreshCw className={cn('h-4 w-4', versionsLoading && 'animate-spin')} />
                  </Button>
                </div>
              </div>
            ) : null}
            {needsLoader ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label className="shrink-0">
                    {editType === 'forge' ? 'Forge 版本' : editType === 'fabric' ? 'Fabric Loader 版本' : 'Velocity 版本'}
                  </Label>
                  {running ? (
                    <span className="min-w-0 truncate text-right text-xs text-muted-foreground">运行中不可更换,请先停止</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Select value={loaderVersion} onValueChange={setLoaderVersion} disabled={loaderLoading || running}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder={loaderLoading ? '加载中…' : '选择版本'} />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {loaderVersion && !loaders.includes(loaderVersion) ? (
                        <SelectItem value={loaderVersion}>{loaderVersion}(当前)</SelectItem>
                      ) : null}
                      {loaders.map((v) => (<SelectItem key={v} value={v}>{v}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" size="icon" className="shrink-0" disabled={loaderLoading || running} title="刷新版本列表" onClick={refreshLoaders}>
                    <RefreshCw className={cn('h-4 w-4', loaderLoading && 'animate-spin')} />
                  </Button>
                </div>
              </div>
            ) : null}
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
            <div className="space-y-2">
              <Label>互联组</Label>
              <Select value={groupId === null ? NO_GROUP : String(groupId)} onValueChange={(v) => setGroupId(v === NO_GROUP ? null : Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GROUP}>不加入</SelectItem>
                  {groups.map((g) => (<SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>))}
                </SelectContent>
              </Select>
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
                <div className="space-y-2">
                  <Label>默认连接顺序(try)</Label>
                  <p className="text-xs text-muted-foreground">玩家进入代理时,按此顺序尝试连接第一个可用的子服。子服需先在「代理网络」一键接线后才会出现。</p>
                  {velCfg.try_servers.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">try 列表为空。{velCfg.servers.length === 0 ? '还没有已接线的子服。' : '从下方添加子服。'}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {velCfg.try_servers.map((key, i) => {
                        const addr = velCfg.servers.find((s) => s.key === key)?.addr
                        return (
                          <div key={key} className="flex items-center gap-2 rounded-md border border-border/70 bg-background/60 px-3 py-1.5">
                            <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{i + 1}</span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{key}</span>
                            {addr ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{addr}</span> : <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400">未接线</span>}
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={i === 0} title="上移" onClick={() => setVelCfg((c) => { const t = [...c.try_servers]; [t[i - 1], t[i]] = [t[i], t[i - 1]]; return { ...c, try_servers: t } })}>
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={i === velCfg.try_servers.length - 1} title="下移" onClick={() => setVelCfg((c) => { const t = [...c.try_servers]; [t[i + 1], t[i]] = [t[i], t[i + 1]]; return { ...c, try_servers: t } })}>
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" title="移出 try" onClick={() => setVelCfg((c) => ({ ...c, try_servers: c.try_servers.filter((k) => k !== key) }))}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {velCfg.servers.some((s) => !velCfg.try_servers.includes(s.key)) ? (
                    <Select value="" onValueChange={(v) => setVelCfg((c) => (c.try_servers.includes(v) ? c : { ...c, try_servers: [...c.try_servers, v] }))}>
                      <SelectTrigger className="h-8"><SelectValue placeholder="添加子服到 try…" /></SelectTrigger>
                      <SelectContent>
                        {velCfg.servers.filter((s) => !velCfg.try_servers.includes(s.key)).map((s) => (
                          <SelectItem key={s.key} value={s.key}>{s.key}（{s.addr}）</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
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
            <div className="space-y-2">
              <Label>MCDR 语言</Label>
              <Select value={mcdrLang || 'auto'} onValueChange={(v) => setMcdrLang(v === 'auto' ? '' : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">不修改</SelectItem>
                  <SelectItem value="zh_cn">简体中文 (zh_cn)</SelectItem>
                  <SelectItem value="en_us">English (en_us)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-startup">开服自动执行指令</Label>
              <Textarea id="edit-startup" value={startupCmds} onChange={(e) => setStartupCmds(e.target.value)} rows={3} placeholder="每行一条,服务器加载完成(Done)后依次发送" className="font-mono" />
            </div>
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
              <Label htmlFor="edit-startcmd">自定义启动命令</Label>
              <Textarea id="edit-startcmd" value={startCmd} onChange={(e) => setStartCmd(e.target.value)} placeholder={commandPreview || '正在生成默认启动命令…'} title={commandPreview} rows={3} className="font-mono" />
              {commandPreviewError ? <p role="alert" className="text-xs text-destructive">{commandPreviewError}</p> : null}
            </div>
            {!isVelocity ? (
              <div className="space-y-2 rounded-md border border-border/70 px-3 py-2.5">
                <label className="flex items-center justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium">启用 RCON</span>
                    <span className="block text-xs text-muted-foreground">世界地图位置采集依赖 RCON。开启后自动分配端口+随机密码,改动需重启实例后生效。</span>
                  </span>
                  <Switch checked={rconInfo?.enabled ?? false} disabled={rconBusy || locked} onCheckedChange={doToggleRcon} />
                </label>
                {rconInfo?.enabled ? (
                  <div className="space-y-2 pt-1">
                    <div className="grid grid-cols-[100px_1fr] gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="rcon-port" className="text-xs">端口</Label>
                        <Input id="rcon-port" type="number" value={rconPort} onChange={(e) => setRconPort(e.target.value)} className="h-8" />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="rcon-pwd" className="text-xs">密码</Label>
                        <Input id="rcon-pwd" value={rconPwd} onChange={(e) => setRconPwd(e.target.value)} className="h-8 font-mono text-xs" />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={rconBusy} onClick={() => { void navigator.clipboard?.writeText(rconPwd); showToast('success', '密码已复制') }}>复制密码</Button>
                      <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={rconBusy} onClick={applyRcon}>应用端口/密码</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
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

function ManageGroupsDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const confirm = useConfirm()
  const prompt = usePrompt()
  const { showToast } = useGlobalToast()
  const [groups, setGroups] = useState<ServerGroup[]>([])
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => listGroups().then(setGroups).catch(() => undefined)
  useEffect(() => {
    if (open) {
      setNewName('')
      load()
    }
  }, [open])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) showToast('success', ok)
      await load()
      onChanged()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const create = () => {
    if (!newName.trim()) return
    run(() => createGroup(newName.trim()), '已创建').then(() => setNewName(''))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>互联组管理</DialogTitle>
          <DialogDescription>组内 MC 实例的玩家聊天可互相转发(纯组织,与权限无关)。</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          {groups.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">还没有互联组。</p>
          ) : (
            groups.map((g) => (
              <div key={g.id} className="flex items-center gap-2 rounded-md border border-border/70 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{g.server_count} 实例 · QQ {g.qq_group_ids.length}</span>
                <span className="flex shrink-0 items-center gap-1.5" title="组内聊天互转">
                  <span className="text-xs text-muted-foreground">互联</span>
                  <Switch checked={g.bridge_enabled} disabled={busy} onCheckedChange={(v) => run(() => updateGroup(g.id, { bridge_enabled: v }))} />
                </span>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" disabled={busy} title="绑定 QQ 群" onClick={async () => {
                  const n = await prompt({ title: '绑定 QQ 群', label: '群号(多个用逗号分隔,留空清除)', defaultValue: g.qq_group_ids.join(', '), placeholder: '如 123456, 789012' })
                  if (n === null) return
                  const ids = Array.from(new Set(n.split(/[,，\s]+/).map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x))))
                  run(() => updateGroup(g.id, { qq_group_ids: ids }), '已更新 QQ 群绑定')
                }}>
                  <MessageSquare className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" disabled={busy} title="重命名" onClick={async () => {
                  const n = await prompt({ title: '重命名互联组', label: '新名称', defaultValue: g.name })
                  if (n && n.trim() && n.trim() !== g.name) run(() => updateGroup(g.id, { name: n.trim() }), '已重命名')
                }}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" disabled={busy} title="删除" onClick={async () => {
                  if (await confirm({ title: `删除互联组「${g.name}」?`, description: '组内服务器会被解绑(不删除服务器)。', confirmText: '删除', destructive: true })) run(() => deleteGroup(g.id), '已删除')
                }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}

          <div className="flex items-center gap-2 pt-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="新互联组名称"
              onKeyDown={(e) => { if (e.key === 'Enter') create() }}
            />
            <Button type="button" className="gap-1.5 shrink-0" disabled={busy || !newName.trim()} onClick={create}>
              <Plus className="h-4 w-4" />
              新建
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
