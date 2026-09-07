import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, FileText, Folder, FolderOpen, Loader2, LockKeyhole, RefreshCw, Save } from 'lucide-react'

import { listServerFiles, readServerFile, saveServerFile, type ServerDirectory, type ServerFileContent } from '@/api/serverFiles'
import type { ServerSummary } from '@/api/servers'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useConfirm } from '@/components/ui/dialog-context'
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
  const { showToast } = useGlobalToast()
  const [directory, setDirectory] = useState<ServerDirectory>({ path: '', entries: [] })
  const [address, setAddress] = useState('/')
  const [file, setFile] = useState<ServerFileContent | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
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
    return () => { mounted.current = false; request.current?.abort() }
  }, [load])

  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])

  const discardThen = async (action: () => void) => {
    if (savingRef.current || confirming.current) return
    confirming.current = true
    try {
      if (dirty && !await confirm({ title: '放弃未保存的修改？', description: '当前文件的修改尚未保存。', confirmText: '放弃修改', destructive: true })) return
      if (mounted.current) action()
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
        ? { ...entry, size_bytes: result.size_bytes, modified_at: result.modified_at } : entry) }))
      showToast('success', '文件已保存')
    } catch (err) {
      if (mounted.current) setError(`${err instanceof Error ? err.message : '保存失败'}。你的修改仍保留在编辑器中。`)
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void discardThen(onClose) }}>
      <DialogContent className="flex h-[92dvh] max-h-[1100px] w-[96vw] max-w-[1500px] flex-col gap-3 p-4 sm:p-6">
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <FolderOpen className="h-5 w-5 shrink-0" /><span className="truncate">服务器文件 — {server.name}</span>
          </DialogTitle>
          <DialogDescription>根目录仅限当前实例。点击文件夹进入，点击文本文件编辑；支持 UTF-8 文本，最大 1 MiB。</DialogDescription>
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
        {error ? <p role="alert" className="max-h-24 shrink-0 overflow-auto break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{error}</p> : null}
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(120px,0.8fr)_minmax(180px,1.2fr)] gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:grid-rows-1">
          <section aria-label="文件资源管理器" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-background">
            <div className="flex shrink-0 items-center justify-between border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span className="truncate" title={`/${directory.path}`}>/{directory.path || ' · 实例根目录'}</span>
              <span className="ml-2 flex shrink-0 items-center gap-1">{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{directory.entries.length} 项</span>
            </div>
            <Table className="min-w-[500px]" containerClassName="min-h-0 flex-1 max-h-none">
              <TableHeader className="sticky top-0 z-10 bg-background"><TableRow>
                <TableHead>名称</TableHead><TableHead className="w-24">大小</TableHead><TableHead className="w-40">修改时间</TableHead>
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
                  </TableRow>
                ))}
                {!directory.entries.length ? <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">{loading ? '加载中…' : '此目录为空'}</TableCell></TableRow> : null}
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
