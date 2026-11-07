import { useEffect, useRef, useState } from 'react'
import { Box, Download, Info, Loader2, Trash2, Upload } from 'lucide-react'

import { ApiError } from '@/api/client'
import {
  type LitematicaFile,
  type LitematicaInfo,
  deleteLitematica,
  downloadLitematica,
  getLitematicaInfo,
  listLitematica,
  uploadLitematica,
} from '@/api/litematica'
import { LitematicaViewer } from '@/components/LitematicaViewer'
import { InlineLoader } from '@/components/PageLoader'
import { Pagination } from '@/components/Pagination'
import { usePaged } from '@/lib/use-paged'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useConfirm } from '@/components/ui/dialog-context'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'


function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

const blockName = (id: string) => id.replace(/^minecraft:/, '').replace(/_/g, ' ')

export default function Litematica() {
  const { showToast } = useGlobalToast()
  const confirm = useConfirm()
  const { data: files, loading, error, refresh } = useResource(() => listLitematica(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [info, setInfo] = useState<{ name: string; data: LitematicaInfo } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const paged = usePaged(files ?? [], 20)
  useEffect(() => {
    if (!files?.some(file => !file.info)) return
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [files, refresh])

  const onUpload = async (file: File) => {
    setBusy('upload')
    try {
      await uploadLitematica(file)
      showToast('success', '已上传,大投影正在后台解析…')
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '上传失败')
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const showInfo = async (f: LitematicaFile) => {
    setBusy(f.name)
    try {
      setInfo({ name: f.name, data: await getLitematicaInfo(f.name) })
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '解析失败')
    } finally {
      setBusy(null)
    }
  }

  const onDelete = async (f: LitematicaFile) => {
    if (!(await confirm({ title: `删除投影「${f.name}」?`, confirmText: '删除', destructive: true }))) return
    setBusy(f.name)
    try {
      await deleteLitematica(f.name)
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '删除失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="Litematica 投影"
      description="三维预览、分层查看与材料清单"
      width="7xl"
      actions={
        <>
          <input ref={fileRef} type="file" accept=".litematic" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f) }} />
          <Button type="button" className="gap-2" disabled={busy === 'upload'} onClick={() => fileRef.current?.click()}>
            {busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}上传投影
          </Button>
        </>
      }
    >
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <PageSurface bodyClassName="p-0">
        {loading ? (
          <div className="py-10"><InlineLoader /></div>
        ) : (files ?? []).length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">还没有投影文件,点右上角上传 .litematic。</p>
        ) : (
          <div className="px-2 pb-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-48">尺寸 / 方块数</TableHead>
                  <TableHead className="w-24 text-right">文件</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.pageItems.map((f) => (
                  <TableRow key={f.name}>
                    <TableCell className="font-medium">
                      <button type="button" className="flex items-center gap-2 text-left hover:text-primary" onClick={() => showInfo(f)} disabled={busy === f.name}><Box className="h-4 w-4 shrink-0 text-muted-foreground" />{f.name}</button>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {f.info ? `${f.info.size.join('×')} · ${f.info.total_blocks.toLocaleString()} 方块` : '待解析 · 点击查看'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">{fmtBytes(f.size_bytes)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="预览与材料" aria-label={`预览 ${f.name}`} disabled={busy === f.name} onClick={() => showInfo(f)}>
                          {busy === f.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Info className="h-4 w-4" />}
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="下载" onClick={() => downloadLitematica(f.name)}>
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="删除" onClick={() => onDelete(f)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination page={paged.page} pageCount={paged.pageCount} total={paged.total} onPage={paged.setPage} />
          </div>
        )}
      </PageSurface>

      {/* 信息/材料 */}
      <Dialog open={info !== null} onOpenChange={(o) => (!o ? setInfo(null) : undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader><DialogTitle>{info?.name}</DialogTitle><DialogDescription>查看投影结构、分层细节和所需材料。</DialogDescription></DialogHeader>
          {info ? (
            <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
              <LitematicaViewer key={info.name} name={info.name} />
              <aside className="min-w-0 space-y-3 lg:border-l lg:pl-5"><h3 className="text-sm font-semibold">材料清单</h3>
              <div className="text-xs text-muted-foreground">
                尺寸 {info.data.size.join(' × ')} · 区域 {info.data.regions} · 方块 {info.data.total_blocks.toLocaleString()}
              </div>
              <div className="max-h-[480px] space-y-0.5 overflow-y-auto">
                {info.data.materials.map((m) => (
                  <div key={m.id} className="flex items-center justify-between px-2 py-1 text-sm">
                    <span className="truncate capitalize">{blockName(m.id)}</span>
                    <span className="font-mono text-muted-foreground">{m.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
              </aside>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

    </PageShell>
  )
}
