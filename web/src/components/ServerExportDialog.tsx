import { useEffect, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { downloadServerPackage, exportServerPackage, waitTransfer, type UploadState } from '@/api/uploads'
import { UploadProgress } from '@/components/UploadProgress'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function ServerExportDialog({server,onClose}:{server:{id:number;name:string};onClose:()=>void}) {
  const [state,setState]=useState<UploadState|null>(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const controller=useRef<AbortController|null>(null)
  useEffect(()=>()=>controller.current?.abort(),[])
  const start=async()=>{
    const abort=new AbortController();controller.current=abort
    setBusy(true);setError('')
    try {
      const result=await exportServerPackage(server.id)
      await waitTransfer(result,setState,abort.signal)
    }catch(err){if(!abort.signal.aborted)setError(err instanceof Error?err.message:'导出失败')}
    finally{if(!abort.signal.aborted)setBusy(false)}
  }
  const download=async()=>{
    if(!state)return
    setBusy(true);setError('')
    try{await downloadServerPackage(state.id)}catch(err){setError(err instanceof Error?err.message:'下载失败')}
    finally{setBusy(false)}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose()}}><DialogContent onInteractOutside={e=>{if(busy)e.preventDefault()}}>
    <DialogHeader><DialogTitle>整包导出 · {server.name}</DialogTitle><DialogDescription>包含核心、世界、配置、插件和日志。请先停止实例；导出的 ZIP 可以再次导入。</DialogDescription></DialogHeader>
    {state&&<UploadProgress state={state}/>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>{state?.status==='done'?<Button disabled={busy} onClick={()=>void download()} className="gap-2"><Download className="h-4 w-4"/>下载 ZIP</Button>:<Button disabled={busy} onClick={()=>void start()} className="gap-2">{busy?<Loader2 className="h-4 w-4 animate-spin"/>:null}{busy?'打包中…':'开始导出'}</Button>}</DialogFooter>
  </DialogContent></Dialog>
}
