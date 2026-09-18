import type { UploadState } from '@/api/uploads'
import { Progress } from '@/components/ui/progress'

function fileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

export function UploadProgress({ state }: { state: UploadState }) {
  const uploading = state.status === 'uploading'
  const completed = state.status === 'done'
  const done = uploading ? state.received : state.processed
  const total = uploading ? state.size : state.total
  const percent = completed ? 100 : total ? Math.min(100, done / total * 100) : 0
  return <div className="min-w-0 space-y-2" role="status" aria-live="polite">
    <div className="flex justify-between gap-3 text-sm"><span className="truncate" title={state.name}>{state.name}</span><span className="shrink-0 text-muted-foreground">{state.stage}{total > 0 || completed ? ` ${Math.floor(percent)}%` : '…'}</span></div>
    <Progress value={percent} className="h-1.5" aria-label={state.stage} />
    {total > 0 && !completed && <p className="text-xs tabular-nums text-muted-foreground">{fileSize(done)} / {fileSize(total)}</p>}
  </div>
}
