import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, Search, Trash2, Upload } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type CataloguePlugin,
  deletePlugin,
  getCatalogue,
  installPlugin,
  listPlugins,
  switchPlugin,
  uploadPlugin,
} from '@/api/plugins'
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
            <TabsTrigger value="catalogue">插件库</TabsTrigger>
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
            <CatalogueTab serverId={serverId} onInstalled={() => installed.refresh()} />
          </TabsContent>
        </Tabs>
      )}
    </PageShell>
  )
}

function CatalogueTab({ serverId, onInstalled }: { serverId: number; onInstalled: () => void }) {
  const { showToast } = useGlobalToast()
  const { data, loading, error, refresh } = useResource(() => getCatalogue(), [])
  const [query, setQuery] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const list = data ?? []
    const q = query.trim().toLowerCase()
    const matched = q
      ? list.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      : list
    return matched.slice(0, 80)
  }, [data, query])

  const install = async (p: CataloguePlugin) => {
    setInstalling(p.id)
    try {
      const r = await installPlugin(serverId, p.id)
      showToast('success', r.requirements_ok === false ? '已安装(部分依赖安装失败)' : '已安装')
      onInstalled()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '安装失败')
    } finally {
      setInstalling(null)
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
                    <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={installing === p.id} onClick={() => install(p)}>
                      {installing === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      安装
                    </Button>
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
