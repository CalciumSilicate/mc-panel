import { useEffect, useRef, useState } from 'react'
import { ArrowUp, FileArchive, Folder, FolderOpen, Loader2, Upload } from 'lucide-react'
import { browseServerDirectories, getTransfer, importServerSource, uploadFile, waitTransfer, type LocalDirectories, type UploadState } from '@/api/uploads'
import { UploadProgress } from '@/components/UploadProgress'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { nsKey } from '@/config'

const EXTENSIONS = ['.zip', '.rar', '.7z', '.tar.gz', '.tar']
const TASK_KEY = nsKey('server-import-task')

export function ServerImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [mode, setMode] = useState<'package' | 'local'>('package')
  const [source, setSource] = useState<'upload' | 'url'>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [directory, setDirectory] = useState<LocalDirectories | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [progress, setProgress] = useState<UploadState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const browserController = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const imported = useRef(onImported)
  imported.current = onImported
  useEffect(() => {
    const id = localStorage.getItem(TASK_KEY)
    const abort = new AbortController()
    controller.current = abort
    if(id) {
      setBusy(true)
      void getTransfer(id, abort.signal).then(state=>waitTransfer(state,setProgress,abort.signal)).then(()=>{
        localStorage.removeItem(TASK_KEY)
        imported.current()
      }).catch(err=>{
        if(!abort.signal.aborted) {
          setError(err instanceof Error?err.message:'读取导入进度失败')
          if(err?.status===404) localStorage.removeItem(TASK_KEY)
        }
      }).finally(()=>{if(!abort.signal.aborted)setBusy(false)})
    }
    return ()=>{controller.current?.abort();browserController.current?.abort()}
  }, [])

  const browse = async (value: string) => {
    browserController.current?.abort()
    const abort=new AbortController()
    browserController.current=abort
    setBrowsing(true);setError('')
    try {
      const result=await browseServerDirectories(value,abort.signal)
      setDirectory(result);setPath(result.path)
    } catch(err) {if(!abort.signal.aborted)setError(err instanceof Error?err.message:'读取目录失败')}
    finally {if(!abort.signal.aborted)setBrowsing(false)}
  }
  const selectFile = (next?: File) => {
    if(!next || busy)return
    if(!EXTENSIONS.some(ext=>next.name.toLowerCase().endsWith(ext))) {setError('支持 ZIP、RAR、7Z、TAR.GZ、TAR 格式');return}
    if(next.size>20*1024**3) {setError('文件不能超过 20 GiB');return}
    setFile(next);setProgress(null);setError('')
  }
  const start = async () => {
    if(busy)return
    const abort=new AbortController()
    controller.current=abort
    setBusy(true);setError('')
    try {
      const saved=localStorage.getItem(TASK_KEY)
      if(saved) {
        const state=await getTransfer(saved,abort.signal)
        if(state.status==='error') localStorage.removeItem(TASK_KEY)
        else {
          await waitTransfer(state,setProgress,abort.signal)
          localStorage.removeItem(TASK_KEY)
          imported.current()
          return
        }
      }
      if(mode==='package' && source==='upload') {
        if(!file)return
        await uploadFile(file,{kind:'package'},setProgress,abort.signal)
      } else {
        const state=await importServerSource(mode==='local'?'local':'url',mode==='local'?path:url)
        localStorage.setItem(TASK_KEY,state.id)
        await waitTransfer(state,setProgress,abort.signal)
        localStorage.removeItem(TASK_KEY)
      }
      imported.current()
    } catch(err) {if(!abort.signal.aborted)setError(err instanceof Error?err.message:'导入失败')}
    finally {if(!abort.signal.aborted)setBusy(false)}
  }
  const valid=mode==='local'?!!path.trim():source==='upload'?!!file:!!url.trim()
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose()}}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" onInteractOutside={e=>{if(busy)e.preventDefault()}}>
      <DialogHeader><DialogTitle>导入服务器</DialogTitle><DialogDescription>支持 MCDR 实例与原版服务端。</DialogDescription></DialogHeader>
      <div className="space-y-4 min-w-0">
        <Tabs value={mode} onValueChange={value=>{setMode(value as typeof mode);setProgress(null);setError('');if(value==='local'&&!directory)void browse('')}}>
          <TabsList className="grid w-full grid-cols-2"><TabsTrigger value="package" disabled={busy}>服务器包</TabsTrigger><TabsTrigger value="local" disabled={busy}>本地文件夹</TabsTrigger></TabsList>
        </Tabs>
        {mode==='package'? <div className="space-y-3">
          <div className="flex gap-2"><Button variant={source==='upload'?'secondary':'ghost'} size="sm" disabled={busy} onClick={()=>setSource('upload')}>上传文件</Button><Button variant={source==='url'?'secondary':'ghost'} size="sm" disabled={busy} onClick={()=>setSource('url')}>下载直链</Button></div>
          {source==='upload'? <div onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();selectFile(e.dataTransfer.files[0])}}>
            <input ref={fileInput} type="file" accept={EXTENSIONS.join(',')} aria-label="服务器包" className="hidden" disabled={busy} onChange={e=>{selectFile(e.target.files?.[0]);e.target.value=''}} />
            <button type="button" aria-label="选择服务器包" disabled={busy} onClick={()=>fileInput.current?.click()} className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-dashed p-5 text-left hover:bg-muted/40 disabled:opacity-50">
              <FileArchive className="h-6 w-6 shrink-0 text-primary"/><span className="min-w-0"><span className="block truncate font-medium">{file?.name??'选择或拖入服务器包'}</span><span className="mt-1 block text-xs text-muted-foreground">{file?`${(file.size/1024**2).toFixed(1)} MiB`:'ZIP / RAR / 7Z / TAR.GZ / TAR · 最大 20 GiB'}</span></span>
            </button>
          </div>:<div className="space-y-2"><Label htmlFor="import-url">下载直链</Label><Input id="import-url" value={url} disabled={busy} placeholder="https://example.com/server.zip" onChange={e=>setUrl(e.target.value)}/><p className="text-xs text-muted-foreground">由面板下载并导入，无需先下载到浏览器。</p></div>}
        </div>:<div className="space-y-3">
          <div className="flex gap-2"><Input id="import-path" aria-label="服务器文件夹" className="h-8 text-xs" value={path} disabled={busy} placeholder="输入绝对路径，或在下方浏览" onChange={e=>setPath(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void browse(path)}}}/><Button variant="outline" size="sm" className="h-8 text-xs" disabled={busy||browsing} onClick={()=>void browse(path)}>浏览</Button></div>
          <div className="rounded-lg border">
            <div className="flex h-8 items-center gap-2 border-b px-2 text-xs text-muted-foreground"><FolderOpen className="h-3.5 w-3.5 shrink-0"/><span className="min-w-0 flex-1 truncate" title={directory?.path}>{directory?.path||'本机磁盘'}</span><Button variant="ghost" size="icon" className="h-6 w-6" disabled={busy||browsing||directory?.parent==null} aria-label="上一级目录" onClick={()=>void browse(directory?.parent??'')}><ArrowUp className="h-3.5 w-3.5"/></Button></div>
            <div className="h-48 overflow-y-auto p-1">{browsing?<div className="flex h-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin"/></div>:directory?.directories.length?directory.directories.map(item=><button key={item.path} type="button" disabled={busy} className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs leading-4 hover:bg-muted disabled:opacity-50" onClick={()=>void browse(item.path)}><Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/><span className="truncate">{item.name}</span></button>):<p className="p-2 text-xs text-muted-foreground">没有子文件夹，可以导入当前目录。</p>}</div>
          </div>
        </div>}
        {progress&&<UploadProgress state={progress}/>}
        {progress?.status==='done'&&<p className="text-sm text-muted-foreground">导入完成，可在实例列表查看并启动服务器。</p>}
        {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          {busy&&progress?.status==='uploading'?<Button variant="outline" onClick={()=>{controller.current?.abort();setBusy(false)}}>暂停</Button>:null}
          <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
          {progress?.status!=='done'&&<Button disabled={busy||!valid} className="gap-2" onClick={()=>void start()}>{busy?<Loader2 className="h-4 w-4 animate-spin"/>:<Upload className="h-4 w-4"/>}{busy?'导入中…':'导入服务器'}</Button>}
        </div>
      </div>
    </DialogContent>
  </Dialog>
}
