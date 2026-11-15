import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { listArchiveVersions } from '@/api/archives'
import type { VersionChannel } from '@/api/servers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const CHANNEL_LABEL: Record<VersionChannel, string> = {
  release: '正式版', snapshot: '快照版', experimental: '实验版',
}

export function ArchiveVersionSelect({ value, onChange, disabled }: {
  value: string
  onChange: (version: string) => void
  disabled: boolean
}) {
  const [custom, setCustom] = useState(false)
  const [channel, setChannel] = useState<VersionChannel>('release')
  const [versions, setVersions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)

  const load = useCallback(async (refresh = false) => {
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    setLoading(true)
    setVersions([])
    setError('')
    try {
      const result = await listArchiveVersions(channel, refresh, abort.signal)
      if (!abort.signal.aborted) setVersions(result)
    } catch {
      if (!abort.signal.aborted) setError('版本列表加载失败，可刷新重试或输入自定义版本。')
    } finally {
      if (!abort.signal.aborted) setLoading(false)
    }
  }, [channel])

  useEffect(() => {
    if (!custom) void load()
    return () => request.current?.abort()
  }, [custom, load])

  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor="arc-ver">MC 版本</Label>
      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={disabled} onClick={() => setCustom(!custom)}>
        {custom ? '从列表选择' : '自定义版本'}
      </Button>
    </div>
    {custom ? <Input id="arc-ver" value={value} onChange={event => onChange(event.target.value)} maxLength={64}
      disabled={disabled} placeholder="输入版本号，留空表示未指定" /> : <>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="w-20 shrink-0" disabled={disabled}
          title="切换版本频道" onClick={() => setChannel(current => current === 'release' ? 'snapshot' : current === 'snapshot' ? 'experimental' : 'release')}>
          {CHANNEL_LABEL[channel]}
        </Button>
        <Select value={value} onValueChange={onChange} disabled={disabled || loading}>
          <SelectTrigger id="arc-ver" className="min-w-0 flex-1">
            <SelectValue placeholder={loading ? '加载中…' : '选择版本'} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {value && !versions.includes(value) ? <SelectItem value={value}>{value}（当前）</SelectItem> : null}
            {versions.map(version => <SelectItem key={version} value={version}>{version}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="icon" className="shrink-0" disabled={disabled || loading}
          title="刷新版本列表" aria-label="刷新版本列表" onClick={() => void load(true)}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {!loading && !error && !versions.length ? <p className="text-xs text-muted-foreground">暂无可选版本，可切换频道或输入自定义版本。</p> : null}
    </>}
  </div>
}
