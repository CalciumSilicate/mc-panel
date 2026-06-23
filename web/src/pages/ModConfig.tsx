import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Download, Loader2, RefreshCw, Save } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type ModPreset,
  type ModPresetField,
  type ModPresetStatus,
  getModPresetConfig,
  getModPresetStatus,
  installModPreset,
  listModPresets,
  refreshModPresetStatus,
  updateModPresetConfig,
} from '@/api/modconfigs'
import { type ServerSummary, listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn, fmtRefreshed } from '@/lib/utils'

const TYPE_LABEL: Record<string, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', velocity: 'Velocity' }

function FieldInput({ field, value, onChange }: { field: ModPresetField; value: unknown; onChange: (v: unknown) => void }) {
  if (field.type === 'bool') return <Switch checked={Boolean(value)} onCheckedChange={onChange} />
  if (field.type === 'int')
    return (
      <Input type="number" className="w-40" min={field.min} value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
    )
  return (
    <Input className="w-full max-w-md" value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />
  )
}

function PresetCard({ preset, serverId, serverType, installed, onInstalled }: {
  preset: ModPreset
  serverId: number
  serverType: string
  installed?: boolean // undefined = 状态未加载
  onInstalled: () => void
}) {
  const { showToast } = useGlobalToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)

  const applicable = preset.server_types.includes(serverType)

  useEffect(() => { setOpen(false); setLoaded(false); setValues({}) }, [serverId, installed])

  const loadValues = async () => {
    setLoading(true)
    try {
      const c = await getModPresetConfig(preset.key, serverId)
      setValues(c.values)
      setLoaded(true)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && installed && !loaded) loadValues()
  }

  const install = async () => {
    setBusy(true)
    try {
      await installModPreset(preset.key, serverId)
      showToast('success', `已安装 ${preset.name}`)
      onInstalled()
      setOpen(true)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '安装失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      await updateModPresetConfig(preset.key, serverId, values)
      showToast('success', '已保存')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border/70 bg-background/40">
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={toggle}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{preset.name}</span>
              {installed === undefined
                ? <Badge variant="outline" className="text-[11px] text-muted-foreground/60">检测中</Badge>
                : installed
                  ? <Badge variant="outline" className="text-[11px] text-emerald-600 dark:text-emerald-400">已安装</Badge>
                  : <Badge variant="outline" className="text-[11px] text-muted-foreground">未安装</Badge>}
              <Badge variant="outline" className="text-[11px] text-muted-foreground">{preset.server_types.map((t) => TYPE_LABEL[t] ?? t).join('/')}</Badge>
            </div>
            <div className="truncate text-xs text-muted-foreground">{preset.description}</div>
          </div>
        </button>
        {applicable && installed === false ? (
          <Button type="button" size="sm" className="gap-1.5 shrink-0" onClick={install} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            一键安装
          </Button>
        ) : null}
        <button type="button" onClick={toggle} className="shrink-0">
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>
      </div>

      {open ? (
        <div className="border-t border-border/70 px-4 py-3">
          {!applicable ? (
            <p className="text-sm text-muted-foreground">该实例类型不适用,仅适用于 {preset.server_types.map((t) => TYPE_LABEL[t] ?? t).join('/')} 实例。</p>
          ) : !installed ? (
            <p className="text-sm text-muted-foreground">尚未安装,点上方「一键安装」从 Modrinth 安装并写入默认配置。</p>
          ) : loading ? (
            <div className="py-4"><InlineLoader /></div>
          ) : (
            <div className="space-y-3">
              {preset.fields.map((f) => (
                <div key={f.path} className="flex items-center justify-between gap-2">
                  <Label className="text-sm">{f.label}</Label>
                  <FieldInput field={f} value={values[f.path]} onChange={(v) => setValues((cur) => ({ ...cur, [f.path]: v }))} />
                </div>
              ))}
              <div className="flex justify-end pt-1">
                <Button type="button" className="gap-1.5" onClick={save} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  保存
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default function ModConfig() {
  const { showToast } = useGlobalToast()
  const { data: servers } = useResource(() => listServers(), [])
  const [serverId, setServerId] = useState<number | null>(null)
  const { data: presets, loading } = useResource(() => listModPresets(), [])
  const [status, setStatus] = useState<ModPresetStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const all = useMemo<ServerSummary[]>(() => servers ?? [], [servers])
  const sel = all.find((s) => s.id === serverId) ?? null

  useEffect(() => {
    if (serverId === null && all.length > 0) setServerId(all[0].id)
  }, [all, serverId])

  const loadStatus = () => {
    if (serverId !== null) getModPresetStatus(serverId).then(setStatus).catch(() => undefined)
  }
  useEffect(() => { setStatus(null); loadStatus() }, [serverId]) // eslint-disable-line react-hooks/exhaustive-deps

  const doRefresh = async () => {
    if (serverId === null) return
    setRefreshing(true)
    try {
      setStatus(await refreshModPresetStatus(serverId))
      showToast('success', '已刷新')
    } catch {
      showToast('error', '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <PageShell
      title="模组配置"
      description="ViaVersion / Velocity Proxy 等代理相关模组:一键安装 + 默认配置 + 表单化修改。"
      width="4xl"
      actions={
        all.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">{fmtRefreshed(status?.scanned_at)}</span>
            <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
              <SelectTrigger className="w-52"><SelectValue placeholder="选择服务器" /></SelectTrigger>
              <SelectContent>
                {all.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}（{TYPE_LABEL[s.server_type] ?? s.server_type}）</SelectItem>))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" className="gap-2" onClick={doRefresh} disabled={refreshing}>
              <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />刷新
            </Button>
          </div>
        ) : null
      }
    >
      {all.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有服务器实例。</p></PageSurface>
      ) : loading || serverId === null || sel === null ? (
        <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
      ) : (
        <PageSurface bodyClassName="space-y-3">
          {(presets ?? []).map((p) => (
            <PresetCard key={p.key} preset={p} serverId={serverId} serverType={sel.server_type} installed={status ? Boolean(status.status[p.key]) : undefined} onInstalled={loadStatus} />
          ))}
        </PageSurface>
      )}
    </PageShell>
  )
}
