import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, Loader2, RefreshCw, Replace, Search, Trash2, Upload, X } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type CataloguePlugin,
  type InstalledPlugin,
  deleteFromLibrary,
  deletePlugin,
  getCatalogue,
  installFromLibrary,
  installPlugin,
  listLibrary,
  listPlugins,
  replaceLibraryFile,
  switchPlugin,
  uploadPlugin,
  uploadToLibrary,
} from '@/api/plugins'
import { pollJob } from '@/api/jobs'
import { listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const stripDisabled = (n: string) => (n.endsWith('.disabled') ? n.slice(0, -'.disabled'.length) : n)

function InstalledChip() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 text-sm text-emerald-600 dark:text-emerald-400">
      <Check className="h-4 w-4" /> 已安装
    </span>
  )
}

export default function Plugins() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const [serverId, setServerId] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (serverId === null && servers && servers.length > 0) setServerId(servers[0].id)
  }, [servers, serverId])

  const installed = useResource(
    () => (serverId === null ? Promise.resolve([]) : listPlugins(serverId)),
    [serverId],
  )
  const installedIds = useMemo(
    () => new Set((installed.data ?? []).map((p) => p.id).filter(Boolean)),
    [installed.data],
  )
  const installedFiles = useMemo(
    () => new Set((installed.data ?? []).map((p) => stripDisabled(p.file_name))),
    [installed.data],
  )

  const uninstall = async (match: { id?: string; file?: string }) => {
    if (serverId === null) return
    const files = (installed.data ?? [])
      .filter(
        (p) =>
          (match.id && p.id === match.id) ||
          (match.file && stripDisabled(p.file_name) === stripDisabled(match.file)),
      )
      .map((p) => p.file_name)
    if (!files.length) return
    try {
      for (const f of files) await deletePlugin(serverId, f)
      showToast('success', '已卸载')
      installed.refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '卸载失败')
    }
  }

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key)
    try {
      await fn()
      showToast('success', ok)
      installed.refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || serverId === null) return
    await run('upload', () => uploadPlugin(serverId, file), '已上传')
  }

  return (
    <PageShell
      title="插件管理"
      description="管理实例的 MCDR 插件,或从官方插件库在线安装。"
      width="7xl"
      actions={
        <div className="flex items-center gap-2">
          <Select
            value={serverId === null ? undefined : String(serverId)}
            onValueChange={(v) => setServerId(Number(v))}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="选择服务器" />
            </SelectTrigger>
            <SelectContent>
              {(servers ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      {serverId === null ? (
        <PageSurface>
          <p className="py-10 text-center text-sm text-muted-foreground">请先选择一个服务器。</p>
        </PageSurface>
      ) : (
        <Tabs defaultValue="installed">
          <TabsList>
            <TabsTrigger value="installed">已安装</TabsTrigger>
            <TabsTrigger value="catalogue">官方</TabsTrigger>
            <TabsTrigger value="library">本地</TabsTrigger>
          </TabsList>

          <TabsContent value="installed" className="pt-4">
            <input ref={fileRef} type="file" accept=".mcdr,.pyz,.py" className="hidden" onChange={onUpload} />
            <PageSurface
              title="已安装插件"
              actions={
                <>
                  <Button type="button" variant="outline" className="gap-2" onClick={() => installed.refresh()} disabled={installed.loading}>
                    <RefreshCw className={cn('h-4 w-4', installed.loading && 'animate-spin')} />
                    刷新
                  </Button>
                  <Button type="button" className="gap-2" onClick={() => fileRef.current?.click()} disabled={busy === 'upload'}>
                    {busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    上传
                  </Button>
                </>
              }
              bodyClassName="p-0"
            >
              {installed.loading && !installed.data ? (
                <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
              ) : !installed.data || installed.data.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">还没有插件。</p>
              ) : (
                <div className="ops-table-shell border-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead>版本</TableHead>
                        <TableHead>启用</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {installed.data.map((p) => (
                        <TableRow key={p.file_name}>
                          <TableCell>
                            <div className="font-medium">{p.name}</div>
                            <div className="text-xs text-muted-foreground">{p.file_name}</div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{p.version || '—'}</TableCell>
                          <TableCell>
                            <Switch
                              checked={p.enabled}
                              disabled={busy === p.file_name}
                              onCheckedChange={(c) =>
                                run(p.file_name, () => switchPlugin(serverId, p.file_name, c), c ? '已启用' : '已禁用')
                              }
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              disabled={busy === p.file_name}
                              onClick={() => {
                                if (window.confirm(`删除插件「${p.name}」?`)) run(p.file_name, () => deletePlugin(serverId, p.file_name), '已删除')
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </PageSurface>
          </TabsContent>

          <TabsContent value="catalogue" className="pt-4">
            <CatalogueTab serverId={serverId} installedIds={installedIds} onInstalled={() => installed.refresh()} onUninstall={uninstall} />
          </TabsContent>

          <TabsContent value="library" className="pt-4">
            <LibraryTab serverId={serverId} installedFiles={installedFiles} installedIds={installedIds} onInstalled={() => installed.refresh()} onUninstall={uninstall} />
          </TabsContent>
        </Tabs>
      )}
    </PageShell>
  )
}

function LibraryTab({
  serverId,
  installedFiles,
  installedIds,
  onInstalled,
  onUninstall,
}: {
  serverId: number
  installedFiles: Set<string>
  installedIds: Set<string>
  onInstalled: () => void
  onUninstall: (match: { id?: string; file?: string }) => Promise<void>
}) {
  const { showToast } = useGlobalToast()
  const { data, loading, refresh } = useResource(() => listLibrary(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy('upload')
    try {
      await uploadToLibrary(file)
      showToast('success', '已上传到本地库')
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '上传失败')
    } finally {
      setBusy(null)
    }
  }

  const act = async (p: InstalledPlugin, fn: () => Promise<unknown>, ok: string, after: () => void) => {
    setBusy(p.file_name)
    try {
      await fn()
      showToast('success', ok)
      after()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const replaceRef = useRef<HTMLInputElement>(null)
  const [replacingFor, setReplacingFor] = useState<string | null>(null)
  const startReplace = (fileName: string) => {
    setReplacingFor(fileName)
    replaceRef.current?.click()
  }
  const onReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !replacingFor) return
    const fn = replacingFor
    setReplacingFor(null)
    setBusy(fn)
    try {
      await replaceLibraryFile(fn, file)
      showToast('success', '已替换(含已安装的服务器)')
      refresh()
      onInstalled()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '替换失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <input ref={fileRef} type="file" accept=".mcdr,.pyz,.py" className="hidden" onChange={onUpload} />
      <input ref={replaceRef} type="file" accept=".mcdr,.pyz,.py" className="hidden" onChange={onReplaceFile} />
      <PageSurface
        title="本地库"
        description="上传到面板的插件,可安装到任意服务器。"
        actions={
          <>
            <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              刷新
            </Button>
            <Button type="button" className="gap-2" onClick={() => fileRef.current?.click()} disabled={busy === 'upload'}>
              {busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              上传
            </Button>
          </>
        }
        bodyClassName="p-0"
      >
        {loading && !data ? (
          <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
        ) : !data || data.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">本地库还没有插件。</p>
        ) : (
          <div className="ops-table-shell border-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((p) => (
                  <TableRow key={p.file_name}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{p.file_name}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.version || '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {installedFiles.has(stripDisabled(p.file_name)) || (p.id && installedIds.has(p.id)) ? (
                          <>
                            <InstalledChip />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              title="从服务器卸载"
                              disabled={busy === p.file_name}
                              onClick={async () => {
                                setBusy(p.file_name)
                                try {
                                  await onUninstall({ id: p.id, file: p.file_name })
                                } finally {
                                  setBusy(null)
                                }
                              }}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            className="gap-1.5"
                            disabled={busy === p.file_name}
                            onClick={() => act(p, () => installFromLibrary(serverId, p.file_name), '已安装到服务器', onInstalled)}
                          >
                            {busy === p.file_name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            安装到此服务器
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          title="上传新文件替换(含已安装的服务器)"
                          disabled={busy === p.file_name}
                          onClick={() => startReplace(p.file_name)}
                        >
                          {busy === p.file_name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Replace className="h-4 w-4" />}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          title="从库删除"
                          disabled={busy === p.file_name}
                          onClick={() => {
                            if (window.confirm(`从本地库删除「${p.name}」?`)) act(p, () => deleteFromLibrary(p.file_name), '已删除', refresh)
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageSurface>
    </>
  )
}

function CatalogueTab({
  serverId,
  installedIds,
  onInstalled,
  onUninstall,
}: {
  serverId: number
  installedIds: Set<string>
  onInstalled: () => void
  onUninstall: (match: { id?: string; file?: string }) => Promise<void>
}) {
  const { showToast } = useGlobalToast()
  const { data, loading, error, refresh } = useResource(() => getCatalogue(), [])
  const [query, setQuery] = useState('')
  const [progress, setProgress] = useState<Record<string, number | null>>({})

  const filtered = useMemo(() => {
    const list = data ?? []
    const q = query.trim().toLowerCase()
    const matched = q
      ? list.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      : list
    return matched.slice(0, 80)
  }, [data, query])

  const install = async (p: CataloguePlugin) => {
    setProgress((prev) => ({ ...prev, [p.id]: null }))
    try {
      const { job_id } = await installPlugin(serverId, p.id)
      const final = await pollJob(job_id, (pc) => setProgress((prev) => ({ ...prev, [p.id]: pc })))
      if (final.status === 'error') showToast('error', final.message || '安装失败')
      else {
        showToast('success', '已安装')
        onInstalled()
      }
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '安装失败')
    } finally {
      setProgress((prev) => {
        const next = { ...prev }
        delete next[p.id]
        return next
      })
    }
  }

  return (
    <PageSurface
      title="官方插件库"
      actions={
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索插件" className="w-56 pl-8" />
          </div>
          <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </Button>
        </div>
      }
      bodyClassName="p-0"
    >
      {loading && !data ? (
        <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
      ) : error ? (
        <p className="py-10 text-center text-sm text-destructive">{error}</p>
      ) : (
        <div className="ops-table-shell border-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>插件</TableHead>
                <TableHead>最新版本</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    <div className="line-clamp-1 max-w-md text-xs text-muted-foreground">{p.description || p.id}</div>
                  </TableCell>
                  <TableCell><Badge variant="outline" className="text-[11px]">{p.version || '—'}</Badge></TableCell>
                  <TableCell className="text-right">
                    {installedIds.has(p.id) ? (
                      <div className="flex items-center justify-end gap-1">
                        <InstalledChip />
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="卸载" onClick={() => onUninstall({ id: p.id })}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <Button type="button" size="sm" className="min-w-24 gap-1.5" disabled={p.id in progress} onClick={() => install(p)}>
                        {p.id in progress ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {progress[p.id] != null ? `${progress[p.id]}%` : '安装中'}
                          </>
                        ) : (
                          <>
                            <Download className="h-3.5 w-3.5" />
                            安装
                          </>
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageSurface>
  )
}
