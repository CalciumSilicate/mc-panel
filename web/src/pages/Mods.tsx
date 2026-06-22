import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, Loader2, RefreshCw, Replace, Search, Trash2, Upload, X } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type InstalledMod,
  type ModrinthHit,
  deleteFromLibrary,
  deleteMod,
  installFromLibrary,
  installMod,
  listLibrary,
  listMods,
  modVersions,
  replaceLibraryFile,
  searchModrinth,
  switchMod,
  uploadMod,
  uploadToLibrary,
} from '@/api/mods'
import { pollJob } from '@/api/jobs'
import { listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt']

const stripDisabled = (n: string) => (n.endsWith('.disabled') ? n.slice(0, -'.disabled'.length) : n)

function InstalledChip() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 text-sm text-emerald-600 dark:text-emerald-400">
      <Check className="h-4 w-4" /> 已安装
    </span>
  )
}

export default function Mods() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const [serverId, setServerId] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (serverId === null && servers && servers.length > 0) setServerId(servers[0].id)
  }, [servers, serverId])

  const server = useMemo(() => (servers ?? []).find((s) => s.id === serverId), [servers, serverId])
  const installed = useResource(
    () => (serverId === null ? Promise.resolve([]) : listMods(serverId)),
    [serverId],
  )
  const installedIds = useMemo(
    () => new Set((installed.data ?? []).map((m) => m.id.toLowerCase()).filter(Boolean)),
    [installed.data],
  )
  const installedFiles = useMemo(
    () => new Set((installed.data ?? []).map((m) => stripDisabled(m.file_name))),
    [installed.data],
  )

  const uninstall = async (match: { id?: string; file?: string }) => {
    if (serverId === null) return
    const files = (installed.data ?? [])
      .filter(
        (m) =>
          (match.id && m.id.toLowerCase() === match.id.toLowerCase()) ||
          (match.file && stripDisabled(m.file_name) === stripDisabled(match.file)),
      )
      .map((m) => m.file_name)
    if (!files.length) return
    try {
      for (const f of files) await deleteMod(serverId, f)
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
    await run('upload', () => uploadMod(serverId, file), '已上传')
  }

  return (
    <PageShell
      title="模组管理"
      description="管理实例的模组,或从 Modrinth 在线安装。注意:vanilla 服务端需 Fabric/Forge 等加载器才会加载模组。"
      width="7xl"
      actions={
        <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
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
            <TabsTrigger value="modrinth">Modrinth</TabsTrigger>
            <TabsTrigger value="library">本地</TabsTrigger>
          </TabsList>

          <TabsContent value="installed" className="pt-4">
            <input ref={fileRef} type="file" accept=".jar" className="hidden" onChange={onUpload} />
            <PageSurface
              title="已安装模组"
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
                <p className="py-10 text-center text-sm text-muted-foreground">还没有模组。</p>
              ) : (
                <div className="ops-table-shell border-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead>版本</TableHead>
                        <TableHead>加载器</TableHead>
                        <TableHead>启用</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {installed.data.map((m) => (
                        <TableRow key={m.file_name}>
                          <TableCell>
                            <div className="font-medium">{m.name}</div>
                            <div className="text-xs text-muted-foreground">{m.file_name}</div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{m.version || '—'}</TableCell>
                          <TableCell className="text-muted-foreground">{m.loader || '—'}</TableCell>
                          <TableCell>
                            <Switch
                              checked={m.enabled}
                              disabled={busy === m.file_name}
                              onCheckedChange={(c) => run(m.file_name, () => switchMod(serverId, m.file_name, c), c ? '已启用' : '已禁用')}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              disabled={busy === m.file_name}
                              onClick={() => {
                                if (window.confirm(`删除模组「${m.name}」?`)) run(m.file_name, () => deleteMod(serverId, m.file_name), '已删除')
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

          <TabsContent value="modrinth" className="pt-4">
            <ModrinthTab serverId={serverId} mcVersion={server?.mc_version ?? ''} installedIds={installedIds} onInstalled={() => installed.refresh()} onUninstall={uninstall} />
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

  const act = async (m: InstalledMod, fn: () => Promise<unknown>, ok: string, after: () => void) => {
    setBusy(m.file_name)
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
      <input ref={fileRef} type="file" accept=".jar" className="hidden" onChange={onUpload} />
      <input ref={replaceRef} type="file" accept=".jar" className="hidden" onChange={onReplaceFile} />
      <PageSurface
        title="本地库"
        description="上传到面板的模组,可安装到任意服务器。"
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
          <p className="py-10 text-center text-sm text-muted-foreground">本地库还没有模组。</p>
        ) : (
          <div className="ops-table-shell border-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead>加载器</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((m) => (
                  <TableRow key={m.file_name}>
                    <TableCell>
                      <div className="font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">{m.file_name}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.version || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{m.loader || '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {installedFiles.has(stripDisabled(m.file_name)) || (m.id && installedIds.has(m.id.toLowerCase())) ? (
                          <>
                            <InstalledChip />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              title="从服务器卸载"
                              disabled={busy === m.file_name}
                              onClick={async () => {
                                setBusy(m.file_name)
                                try {
                                  await onUninstall({ id: m.id, file: m.file_name })
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
                            disabled={busy === m.file_name}
                            onClick={() => act(m, () => installFromLibrary(serverId, m.file_name), '已安装到服务器', onInstalled)}
                          >
                            {busy === m.file_name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            安装到此服务器
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          title="上传新文件替换(含已安装的服务器)"
                          disabled={busy === m.file_name}
                          onClick={() => startReplace(m.file_name)}
                        >
                          {busy === m.file_name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Replace className="h-4 w-4" />}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          title="从库删除"
                          disabled={busy === m.file_name}
                          onClick={() => {
                            if (window.confirm(`从本地库删除「${m.name}」?`)) act(m, () => deleteFromLibrary(m.file_name), '已删除', refresh)
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

function ModrinthTab({
  serverId,
  mcVersion,
  installedIds,
  onInstalled,
  onUninstall,
}: {
  serverId: number
  mcVersion: string
  installedIds: Set<string>
  onInstalled: () => void
  onUninstall: (match: { id?: string; file?: string }) => Promise<void>
}) {
  const { showToast } = useGlobalToast()
  const [query, setQuery] = useState('')
  const [loader, setLoader] = useState('fabric')
  const [filterMc, setFilterMc] = useState(true)
  const [hits, setHits] = useState<ModrinthHit[]>([])
  const [searching, setSearching] = useState(false)
  const [progress, setProgress] = useState<Record<string, number | null>>({})

  const search = async () => {
    setSearching(true)
    try {
      setHits(await searchModrinth({ q: query, mcVersion: filterMc ? mcVersion : undefined, loader, limit: 20 }))
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  const install = async (hit: ModrinthHit) => {
    setProgress((prev) => ({ ...prev, [hit.project_id]: null }))
    try {
      const versions = await modVersions(hit.project_id, filterMc ? mcVersion : undefined, loader)
      if (versions.length === 0) {
        showToast('error', '没有匹配当前版本/加载器的发布')
        return
      }
      const { job_id } = await installMod(serverId, versions[0].id)
      const final = await pollJob(job_id, (pc) =>
        setProgress((prev) => ({ ...prev, [hit.project_id]: pc })),
      )
      if (final.status === 'error') showToast('error', final.message || '安装失败')
      else {
        showToast('success', `已安装 ${versions[0].version_number}`)
        onInstalled()
      }
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '安装失败')
    } finally {
      setProgress((prev) => {
        const next = { ...prev }
        delete next[hit.project_id]
        return next
      })
    }
  }

  return (
    <PageSurface bodyClassName="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 p-3">
        <form
          className="relative flex-1 min-w-48"
          onSubmit={(e) => {
            e.preventDefault()
            search()
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 Modrinth 模组,回车搜索" className="pl-8" />
        </form>
        <Select value={loader} onValueChange={setLoader}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {LOADERS.map((l) => (
              <SelectItem key={l} value={l}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 rounded-md border border-border/70 px-3 py-2 text-sm">
          <Switch checked={filterMc} onCheckedChange={setFilterMc} />
          仅 {mcVersion || '当前版本'}
        </label>
        <Button type="button" className="gap-2" onClick={search} disabled={searching}>
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          搜索
        </Button>
      </div>

      {hits.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">输入关键词后搜索 Modrinth。</p>
      ) : (
        <div className="ops-table-shell border-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模组</TableHead>
                <TableHead>下载量</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hits.map((h) => (
                <TableRow key={h.project_id}>
                  <TableCell>
                    <div className="font-medium">{h.title}</div>
                    <div className="line-clamp-1 max-w-md text-xs text-muted-foreground">{h.description}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{h.downloads.toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    {installedIds.has(h.slug.toLowerCase()) ? (
                      <div className="flex items-center justify-end gap-1">
                        <InstalledChip />
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="卸载" onClick={() => onUninstall({ id: h.slug })}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <Button type="button" size="sm" className="min-w-28 gap-1.5" disabled={h.project_id in progress} onClick={() => install(h)}>
                        {h.project_id in progress ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {progress[h.project_id] != null ? `${progress[h.project_id]}%` : '安装中'}
                          </>
                        ) : (
                          <>
                            <Download className="h-3.5 w-3.5" />
                            安装最新
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
