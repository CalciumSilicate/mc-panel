import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Copy, Download, Loader2, Save, Send } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type BatchResult,
  type Preset,
  type PresetField,
  copyConfigTo,
  getPresetConfig,
  installPreset,
  installPresetTo,
  listPresets,
  updatePresetConfig,
} from '@/api/configs'
import { type ServerSummary, listServers } from '@/api/servers'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const TYPE_LABEL: Record<string, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', velocity: 'Velocity' }

function ServerPickerDialog({
  open,
  title,
  description,
  servers,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  servers: ServerSummary[]
  busy: boolean
  onClose: () => void
  onConfirm: (ids: number[]) => void
}) {
  const [sel, setSel] = useState<Set<number>>(new Set())
  useEffect(() => { if (open) setSel(new Set()) }, [open])
  const toggle = (id: number) => setSel((cur) => {
    const n = new Set(cur)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {servers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">没有其他可选服务器。</p>
          ) : (
            servers.map((s) => (
              <button
                key={s.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => toggle(s.id)}
              >
                <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', sel.has(s.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
                  {sel.has(s.id) ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <Badge variant="outline" className="text-[11px]">{TYPE_LABEL[s.server_type] ?? s.server_type}</Badge>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" className="gap-1.5" disabled={busy || sel.size === 0} onClick={() => onConfirm([...sel])}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            应用到 {sel.size} 个
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const MC_TYPES = ['vanilla', 'fabric', 'forge']
const ROLE_LEVELS = ['0 游客', '1 用户', '2 助手', '3 管理', '4 所有者']

function FieldInput({ field, value, onChange }: { field: PresetField; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.type) {
    case 'bool':
      return <Switch checked={Boolean(value)} onCheckedChange={onChange} />
    case 'int':
      return (
        <Input
          type="number"
          className="w-40"
          value={value === null || value === undefined ? '' : String(value)}
          min={field.min}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
    case 'role_level':
      return (
        <Select value={String(value ?? 0)} onValueChange={(v) => onChange(Number(v))}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ROLE_LEVELS.map((l, i) => (<SelectItem key={i} value={String(i)}>{l}</SelectItem>))}
          </SelectContent>
        </Select>
      )
    case 'string_array':
      return (
        <Textarea
          className="min-h-[72px] font-mono text-xs"
          value={(Array.isArray(value) ? value : []).join('\n')}
          placeholder="每行一个"
          onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
        />
      )
    case 'json':
      return (
        <Textarea
          className="min-h-[96px] font-mono text-xs"
          defaultValue={JSON.stringify(value ?? null, null, 2)}
          onChange={(e) => {
            try { onChange(JSON.parse(e.target.value)) } catch { /* 等待合法 JSON */ }
          }}
        />
      )
    case 'crontab':
    case 'date':
    case 'string':
    default:
      return (
        <Input
          className="w-full max-w-md"
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      )
  }
}

function PresetCard({ preset, serverId, servers }: { preset: Preset; serverId: number; servers: ServerSummary[] }) {
  const { showToast } = useGlobalToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<'copy' | 'install' | null>(null)
  const [pickerBusy, setPickerBusy] = useState(false)

  const others = useMemo(() => servers.filter((s) => s.id !== serverId), [servers, serverId])

  const reportBatch = (results: BatchResult[]) => {
    const bad = results.filter((r) => r.status !== 'ok')
    if (bad.length === 0) showToast('success', `已应用到 ${results.length} 个服务器`)
    else showToast('error', `${results.length - bad.length} 成功,${bad.length} 失败:${bad.map((b) => `${b.name}(${b.detail})`).join('、')}`)
  }

  const doBatch = async (ids: number[]) => {
    setPickerBusy(true)
    try {
      const r = picker === 'copy' ? await copyConfigTo(preset.key, serverId, ids) : await installPresetTo(preset.key, ids)
      reportBatch(r.results)
      setPicker(null)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setPickerBusy(false)
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      const c = await getPresetConfig(preset.key, serverId)
      setInstalled(c.installed)
      setValues(c.values)
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  // 切换服务器时重置
  useEffect(() => { setOpen(false); setInstalled(null) }, [serverId])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && installed === null) load()
  }

  const install = async () => {
    setBusy(true)
    try {
      await installPreset(preset.key, serverId)
      showToast('success', `已安装 ${preset.name}`)
      await load()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '安装失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      await updatePresetConfig(preset.key, serverId, values)
      showToast('success', '已保存')
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border/70 bg-background/40">
      <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={toggle}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{preset.name}</span>
            {installed === true ? <Badge variant="outline" className="text-[11px] text-emerald-600 dark:text-emerald-400">已安装</Badge> : null}
            {installed === false ? <Badge variant="outline" className="text-[11px] text-muted-foreground">未安装</Badge> : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">{preset.description}</div>
        </div>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div className="border-t border-border/70 px-4 py-3">
          {loading ? (
            <div className="py-4"><InlineLoader /></div>
          ) : installed === false ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">尚未安装,点击从 MCDR 仓库一键安装并写入默认配置。</span>
              <div className="flex shrink-0 gap-2">
                <Button type="button" variant="outline" className="gap-1.5" onClick={() => setPicker('install')}>
                  <Send className="h-4 w-4" />
                  安装到其他
                </Button>
                <Button type="button" className="gap-1.5" onClick={install} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  一键安装
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {preset.fields.map((f) => (
                <div key={f.path} className={cn('gap-2', f.type === 'string_array' || f.type === 'json' ? 'space-y-1.5' : 'flex items-center justify-between')}>
                  <Label className="text-sm">{f.label}</Label>
                  <FieldInput field={f} value={values[f.path]} onChange={(v) => setValues((cur) => ({ ...cur, [f.path]: v }))} />
                </div>
              ))}
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <Button type="button" variant="outline" className="gap-1.5" onClick={() => setPicker('copy')}>
                  <Copy className="h-4 w-4" />
                  配置到其他
                </Button>
                <Button type="button" variant="outline" className="gap-1.5" onClick={() => setPicker('install')}>
                  <Send className="h-4 w-4" />
                  安装到其他
                </Button>
                <Button type="button" className="gap-1.5" onClick={save} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  保存
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <ServerPickerDialog
        open={picker !== null}
        title={picker === 'copy' ? `把「${preset.name}」配置复制到` : `把「${preset.name}」安装到`}
        description={picker === 'copy' ? '将当前实例该插件的整份配置覆盖到所选实例。' : '在所选实例上安装该插件并写入默认配置。'}
        servers={others}
        busy={pickerBusy}
        onClose={() => setPicker(null)}
        onConfirm={doBatch}
      />
    </div>
  )
}

export default function PluginConfig() {
  const { data: servers } = useResource(() => listServers(), [])
  const [serverId, setServerId] = useState<number | null>(null)
  const { data: presets, loading } = useResource(() => listPresets(), [])

  const mcServers = useMemo<ServerSummary[]>(() => (servers ?? []).filter((s) => MC_TYPES.includes(s.server_type)), [servers])

  useEffect(() => {
    if (serverId === null && mcServers.length > 0) setServerId(mcServers[0].id)
  }, [mcServers, serverId])

  return (
    <PageShell
      title="插件配置"
      description="一批推荐 MCDR 插件:一键安装 + 套用默认配置 + 表单化修改。"
      width="4xl"
      actions={
        mcServers.length > 0 ? (
          <Select value={serverId === null ? undefined : String(serverId)} onValueChange={(v) => setServerId(Number(v))}>
            <SelectTrigger className="w-52"><SelectValue placeholder="选择服务器" /></SelectTrigger>
            <SelectContent>
              {mcServers.map((s) => (<SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>))}
            </SelectContent>
          </Select>
        ) : null
      }
    >
      {mcServers.length === 0 ? (
        <PageSurface><p className="py-10 text-center text-sm text-muted-foreground">还没有 MC 服务器实例。</p></PageSurface>
      ) : loading || serverId === null ? (
        <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
      ) : (
        <PageSurface bodyClassName="space-y-3">
          {(presets ?? []).map((p) => (<PresetCard key={p.key} preset={p} serverId={serverId} servers={mcServers} />))}
        </PageSurface>
      )}
    </PageShell>
  )
}
