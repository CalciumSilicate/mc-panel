import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, FileText, Folder, FolderOpen, Loader2, LockKeyhole, Pencil, RefreshCw, Save, Trash2, Upload } from 'lucide-react'

import { deleteServerEntry, listServerFiles, readServerFile, renameServerEntry, saveServerFile, type ServerDirectory, type ServerFileContent, type ServerFileEntry } from '@/api/serverFiles'
import { pollJob } from '@/api/jobs'
import type { ServerSummary } from '@/api/servers'
import { uploadFile, type UploadState } from '@/api/uploads'
import { UploadProgress } from '@/components/UploadProgress'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useConfirm, usePrompt } from '@/components/ui/dialog-context'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useGlobalToast } from '@/components/ui/use-global-toast'

function sizeLabel(size: number | null) {
  if (size === null) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`
}

// Parent mounts this dialog keyed by instance ID; polling must not reset drafts.
export function ServerFilesDialog({ server, onClose }: { server: ServerSummary; onClose: () => void }) {
  const confirm = useConfirm()
  const prompt = usePrompt()
  const { showToast } = useGlobalToast()
  const [directory, setDirectory] = useState<ServerDirectory>({ path: '', entries: [] })
  const [address, setAddress] = useState('/')
  const [file, setFile] = useState<ServerFileContent | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [operation, setOperation] = useState('')
  const [uploadState, setUploadState] = useState<UploadState | null>(null)
  const [uploading, setUploading] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [uploadQueue, setUploadQueue] = useState<File[]>([])
  const uploadAbort = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const uploadDirectory = useRef('')
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const savingRef = useRef(false)
  const confirming = useRef(false)
  const dirty = file !== null && draft !== file.text
  const readOnly = server.protected || !file?.editable

  const load = useCallback(async (path: string, kind: 'directory' | 'file') => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError('')
    try {
      if (kind === 'directory') {
        const result = await listServerFiles(server.id, path, controller.signal)
        if (controller.signal.aborted || !mounted.current) return
        setDirectory(result)
        setAddress(`/${result.path}`)
        setFile(null)
        setDraft('')
      } else {
        const result = await readServerFile(server.id, path, controller.signal)
        if (controller.signal.aborted || !mounted.current) return
        setFile(result)
        setDraft(result.text)
      }
    } catch (err) {
      if (!controller.signal.aborted && mounted.current) setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      if (!controller.signal.aborted && mounted.current) setLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    mounted.current = true
    void load('', 'directory')
    return () => { mounted.current = false; request.current?.abort(); uploadAbort.current?.abort() }
  }, [load])

  useEffect(() => {
    if (!dirty && !uploading) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty, uploading])

  const discardThen = async (action: () => void | Promise<void>) => {
    if (savingRef.current || confirming.current || uploading) return
    confirming.current = true
    try {
      if (dirty && !await confirm({ title: '放弃未保存的修改？', description: '当前文件的修改尚未保存。', confirmText: '放弃修改', destructive: true })) return
      if (mounted.current) await action()
    } finally { confirming.current = false }
  }

  const save = async () => {
    if (!file || !dirty || readOnly || loading || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const result = await saveServerFile(server.id, file, draft)
      if (!mounted.current) return
      setFile(result)
      setDraft(result.text)
      setDirectory((current) => ({ ...current, entries: current.entries.map((entry) => entry.path === result.path
        ? { ...entry, size_bytes: result.size_bytes, modified_at: result.modified_at, revision: result.entry_revision } : entry) }))
      showToast('success', '文件已保存')
    } catch (err) {
      if (mounted.current) setError(`${err instanceof Error ? err.message : '保存失败'}。你的修改仍保留在编辑器中。`)
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }

  const upload = async (files: File[]) => {
    if (uploading || server.protected || !files.length) return
    const controller = new AbortController()
    uploadAbort.current = controller
    setUploading(true)
    setError('')
    let remaining = files
    setUploadQueue(remaining)
    try {
      for (const entry of files) {
        await uploadFile(entry, { kind: 'file', server_id: server.id, directory: uploadDirectory.current, overwrite },
          value => { if (mounted.current && !controller.signal.aborted) setUploadState(value) }, controller.signal)
        remaining = remaining.slice(1)
        if (mounted.current) setUploadQueue(remaining)
      }
      if (mounted.current) {
        showToast('success', '上传完成')
        void load(uploadDirectory.current, 'directory')
      }
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      if (mounted.current) setUploading(false)
    }
  }

  const changeEntry = (entry: ServerFileEntry, action: 'rename' | 'delete') => {
    if (server.protected || loading || entry.kind === 'blocked' || !entry.revision) return
    void discardThen(async () => {
      const kind = entry.kind === 'directory' ? '文件夹' : '文件'
      let name: string | null = null
      if (action === 'rename') {
        name = await prompt({ title: `重命名${kind}`, label: '名称', defaultValue: entry.name })
        if (name === null || name === entry.name) return
        if (!name || name.includes('/') || name.includes('\\')) { setError('请输入有效名称，不要包含路径'); return }
      } else if (!await confirm({
        title: `删除${kind}？`,
        description: entry.kind === 'directory' ? `“${entry.name}”及其中全部内容将被删除。` : `“${entry.name}”将被删除。`,
        confirmText: '删除', destructive: true,
      })) return
      if (!mounted.current) return
      savingRef.current = true
      setSaving(true)
      setError('')
      setOperation(action === 'rename' ? '重命名中…' : '删除中…')
      try {
        if (action === 'rename') {
          await renameServerEntry(server.id, entry, name!)
          if (mounted.current) await load(directory.path, 'directory')
        } else {
          const { job_id } = await deleteServerEntry(server.id, entry)
          if (mounted.current) await load(directory.path, 'directory')
          const result = await pollJob(job_id, () => {})
          if (result.status === 'error') throw new Error(result.message || '后台清理失败')
        }
        if (mounted.current) showToast('success', action === 'rename' ? '已重命名' : '已删除')
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : '操作失败')
      } finally {
        savingRef.current = false
        if (mounted.current) { setSaving(false); setOperation('') }
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void discardThen(onClose) }}>
      <DialogContent className="flex h-[92dvh] max-h-[1100px] w-[96vw] max-w-[1500px] flex-col gap-3 p-4 sm:p-6">
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <FolderOpen className="h-5 w-5 shrink-0" /><span className="truncate">服务器文件 — {server.name}</span>
          </DialogTitle>
          <DialogDescription>当前实例文件 · 文本编辑上限 1 MiB</DialogDescription>
        </DialogHeader>
        {server.protected ? <p className="shrink-0 text-sm text-amber-600 dark:text-amber-400">实例受保护：仅可浏览，不能保存修改。</p> : null}
        <form className="flex shrink-0 items-center gap-2" onSubmit={(event) => {
          event.preventDefault()
          const path = address.startsWith('/') ? address.slice(1) : address
          void discardThen(() => { void load(path, 'directory') })
        }}>
          <Button type="button" variant="outline" size="icon" title="上一级" aria-label="上一级" disabled={saving || !directory.path}
            onClick={() => { void discardThen(() => { void load(directory.path.split('/').slice(0, -1).join('/'), 'directory') }) }}>
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Input aria-label="文件地址栏" value={address} disabled={saving} onChange={(event) => setAddress(event.target.value)} className="min-w-0 flex-1" spellCheck={false} />
          <Button type="submit" variant="outline" disabled={saving}>前往</Button>
          <Button type="button" variant="outline" size="icon" title="刷新目录" aria-label="刷新目录" disabled={saving}
            onClick={() => { void discardThen(() => { void load(directory.path, 'directory') }) }}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </form>
        {!server.protected && <div className="flex shrink-0 flex-wrap items-center gap-3">
          <input ref={fileInput} type="file" multiple className="hidden" aria-label="选择上传文件" onChange={event => {
            const selected = Array.from(event.target.files ?? [])
            event.target.value = ''
            void discardThen(() => { uploadDirectory.current = directory.path; void upload(selected) })
          }} />
          <Button type="button" variant="outline" size="sm" className="gap-2" disabled={uploading || saving || loading} onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4" />上传文件</Button>
          <label htmlFor={`upload-overwrite-${server.id}`} className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox id={`upload-overwrite-${server.id}`} checked={overwrite} disabled={uploading} onCheckedChange={checked => setOverwrite(checked === true)} />
            替换同名文件
          </label>
          {uploading && uploadState?.status === 'uploading' && <Button size="sm" variant="ghost" onClick={() => uploadAbort.current?.abort()}>暂停</Button>}
          {!uploading && uploadQueue.length > 0 && <Button size="sm" variant="outline" onClick={() => void upload(uploadQueue)}>继续上传</Button>}
          {uploadQueue.length > 1 && <span className="text-xs text-muted-foreground">剩余 {uploadQueue.length} 个文件</span>}
        </div>}
        {uploadState && <div className="shrink-0"><UploadProgress state={uploadState} /></div>}
        {error ? <p role="alert" className="max-h-24 shrink-0 overflow-auto break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{error}</p> : null}
        {operation && <p role="status" className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{operation}</p>}
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(120px,0.8fr)_minmax(180px,1.2fr)] gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:grid-rows-1">
          <section aria-label="文件资源管理器" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-background">
            <div className="flex shrink-0 items-center justify-between border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span className="truncate" title={`/${directory.path}`}>/{directory.path || ' · 实例根目录'}</span>
              <span className="ml-2 flex shrink-0 items-center gap-1">{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{directory.entries.length} 项</span>
            </div>
            <Table className="min-w-[500px]" containerClassName="min-h-0 flex-1 max-h-none">
              <TableHeader className="sticky top-0 z-10 bg-background"><TableRow>
                <TableHead>名称</TableHead><TableHead className="w-24">大小</TableHead><TableHead className="w-40">修改时间</TableHead>
                {!server.protected && <TableHead className="sticky right-0 w-20 bg-background text-right">操作</TableHead>}
              </TableRow></TableHeader>
              <TableBody>
                {directory.entries.map((entry) => (
                  <TableRow key={entry.path} data-state={file?.path === entry.path ? 'selected' : undefined}>
                    <TableCell>
                      <button type="button" className="flex w-full items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50" disabled={saving || entry.kind === 'blocked'}
                        title={entry.reason || entry.name} onClick={() => { void discardThen(() => { void load(entry.path, entry.kind === 'directory' ? 'directory' : 'file') }) }}>
                        {entry.kind === 'directory' ? <Folder className="h-4 w-4 shrink-0 text-amber-500" /> : entry.kind === 'blocked' ? <LockKeyhole className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                        <span className="max-w-64 truncate">{entry.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{entry.kind === 'directory' ? '—' : sizeLabel(entry.size_bytes)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{entry.modified_at ? new Date(entry.modified_at).toLocaleString() : '—'}</TableCell>
                    {!server.protected && <TableCell className="sticky right-0 bg-background py-1.5">
                      <div className="flex justify-end gap-0.5">
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="重命名" aria-label={`重命名 ${entry.name}`} disabled={saving || uploading || loading || entry.kind === 'blocked' || !entry.revision} onClick={() => changeEntry(entry, 'rename')}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="删除" aria-label={`删除 ${entry.name}`} disabled={saving || uploading || loading || entry.kind === 'blocked' || !entry.revision} onClick={() => changeEntry(entry, 'delete')}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </TableCell>}
                  </TableRow>
                ))}
                {!directory.entries.length ? <TableRow><TableCell colSpan={server.protected ? 3 : 4} className="py-8 text-center text-muted-foreground">{loading ? '加载中…' : '此目录为空'}</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </section>
          <section aria-label="文件编辑器" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-background">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-2">
              <span className="min-w-0 flex-1 truncate px-1 text-sm" title={file?.path}>{file ? `/${file.path}` : '文件编辑器'}{dirty ? ' · 未保存' : ''}</span>
              {file ? <>
                <Button type="button" size="sm" variant="ghost" title="重新加载文件" aria-label="重新加载文件" disabled={saving || loading}
                  onClick={() => { void discardThen(() => { void load(file.path, 'file') }) }}><RefreshCw className="h-4 w-4" /></Button>
                <Button type="button" size="sm" className="gap-1.5" disabled={!dirty || readOnly || saving || loading} onClick={() => { void save() }}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存
                </Button>
              </> : null}
            </div>
            {file ? <>
              {file.reason ? <p className="shrink-0 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">{file.reason}</p> : null}
              <Textarea aria-label="文件内容" value={draft} readOnly={readOnly || saving || loading} spellCheck={false} wrap="off"
                className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 font-mono text-sm leading-6 shadow-none focus-visible:ring-inset"
                onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
                }} />
              <div className="flex shrink-0 flex-wrap justify-between gap-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                <span>UTF-8{file.bom ? ' BOM' : ''} · {file.newline} · {sizeLabel(file.size_bytes)}</span>
                <span>{readOnly ? '只读' : 'Ctrl / ⌘ + S 保存'}</span>
              </div>
            </> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-sm text-muted-foreground">
              <FileText className="h-9 w-9 opacity-40" /><p>选择文本文件开始编辑</p><p className="text-xs">不会自动重载配置或重启服务器。</p>
            </div>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
