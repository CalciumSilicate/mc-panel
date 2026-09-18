import { useEffect, useRef, useState } from 'react'
import { FileArchive, Upload } from 'lucide-react'
import { uploadFile, type ImportOptions, type UploadState } from '@/api/uploads'
import { getSuggestedPort } from '@/api/servers'
import { UploadProgress } from '@/components/UploadProgress'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

function packageSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

export function ServerImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [options, setOptions] = useState<ImportOptions>({ name: '', server_type: 'vanilla', mc_version: '', port: 25565, min_memory: '1G', max_memory: '2G', launch_jar: '' })
  const [progress, setProgress] = useState<UploadState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const locked = busy || (progress !== null && progress.status !== 'error' && progress.status !== 'done')
  useEffect(() => {
    const abort = new AbortController()
    void getSuggestedPort().then(port => { if (!abort.signal.aborted) setOptions(current => ({ ...current, port })) }).catch(() => {})
    return () => { abort.abort(); controller.current?.abort() }
  }, [])

  const selectFile = (next: File | undefined) => {
    if (!next || locked) return
    if (!next.name.toLowerCase().endsWith('.zip')) {
      setError('请选择 ZIP 文件')
      return
    }
    if (next.size > 20 * 1024 ** 3) {
      setError('文件不能超过 20 GiB')
      return
    }
    setFile(next)
    setProgress(null)
    setError('')
    setOptions(current => ({
      ...current,
      name: !current.name || current.name === file?.name.replace(/\.zip$/i, '')
        ? next.name.replace(/\.zip$/i, '') : current.name,
    }))
  }

  const start = async () => {
    if (!file || busy) return
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setError('')
    try {
      const result = await uploadFile(file, { kind: 'package', options }, value => { if (!abort.signal.aborted) setProgress(value) }, abort.signal)
      setProgress(result)
      onImported()
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : '导入失败')
    } finally { if (controller.current === abort) setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" onInteractOutside={event => { if (busy) event.preventDefault() }}>
      <DialogHeader><DialogTitle>导入服务器包</DialogTitle><DialogDescription>ZIP · 服务端目录或 MCDR 实例包</DialogDescription></DialogHeader>
      <div className="min-w-0 space-y-4">
        <div className="min-w-0" onDragEnter={event => {
          event.preventDefault()
          if (!locked && event.dataTransfer.types.includes('Files')) {
            dragDepth.current += 1
            setDragging(true)
          }
        }} onDragOver={event => {
          event.preventDefault()
          event.dataTransfer.dropEffect = locked ? 'none' : 'copy'
        }} onDragLeave={event => {
          event.preventDefault()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDragging(false)
        }} onDrop={event => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          if (locked) return
          if (event.dataTransfer.files.length > 1) { setError('每次请选择一个服务器包'); return }
          selectFile(event.dataTransfer.files[0])
        }}>
          <input ref={fileInput} type="file" accept=".zip" aria-label="服务器包" className="hidden" disabled={locked} onChange={event => {
            selectFile(event.target.files?.[0])
            event.target.value = ''
          }} />
          <button type="button" disabled={locked} aria-label={file ? '更换服务器包' : '选择服务器包'}
            onClick={() => fileInput.current?.click()}
            className={cn(
              'flex min-w-0 w-full items-center gap-3 rounded-xl border px-3 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 sm:px-4',
              file ? 'border-border bg-muted/20' : 'border-dashed border-border bg-muted/10',
              dragging ? 'border-primary bg-primary/10' : 'enabled:hover:border-primary/50 enabled:hover:bg-primary/5',
            )}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><FileArchive className="h-5 w-5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" title={file?.name}>{dragging ? '松开以选择文件' : file?.name || '选择服务器包'}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{file ? packageSize(file.size) : 'ZIP · 支持拖拽'}</span>
            </span>
            <span className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-foreground">{file ? '更换' : '浏览'}</span>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5"><Label htmlFor="import-name">实例名称</Label><Input id="import-name" value={options.name} disabled={locked} onChange={e => setOptions({ ...options, name: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="import-type">类型</Label><select id="import-type" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={options.server_type} disabled={locked} onChange={e => setOptions({ ...options, server_type: e.target.value as ImportOptions['server_type'] })}>{['vanilla', 'fabric', 'forge', 'velocity'].map(value => <option key={value} value={value}>{value}</option>)}</select></div>
          <div className="space-y-1.5"><Label htmlFor="import-port">端口</Label><Input id="import-port" type="number" min={1} max={65535} value={options.port} disabled={locked} onChange={e => setOptions({ ...options, port: Number(e.target.value) })} /></div>
          <div className="space-y-1.5"><Label htmlFor="import-min">最小内存</Label><Input id="import-min" value={options.min_memory} disabled={locked} onChange={e => setOptions({ ...options, min_memory: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="import-max">最大内存</Label><Input id="import-max" value={options.max_memory} disabled={locked} onChange={e => setOptions({ ...options, max_memory: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="import-version">MC 版本</Label><Input id="import-version" placeholder="自动识别" value={options.mc_version} disabled={locked} onChange={e => setOptions({ ...options, mc_version: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="import-jar">启动 JAR</Label><Input id="import-jar" placeholder="自动识别" value={options.launch_jar} disabled={locked} onChange={e => setOptions({ ...options, launch_jar: e.target.value })} /></div>
        </div>
        {progress && <UploadProgress state={progress} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          {busy && progress?.status === 'uploading' ? <Button variant="outline" onClick={() => controller.current?.abort()}>暂停</Button> : null}
          {!busy && <Button variant="outline" onClick={onClose}>关闭</Button>}
          {progress?.status !== 'done' && <Button disabled={busy || !file || !options.name.trim()} className="gap-2" onClick={() => void start()}><Upload className="h-4 w-4" />{busy ? '处理中' : progress && progress.status !== 'error' ? '继续' : '开始导入'}</Button>}
        </div>
      </div>
    </DialogContent>
  </Dialog>
}
