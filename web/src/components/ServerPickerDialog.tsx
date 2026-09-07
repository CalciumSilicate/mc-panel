import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'

import { type ServerSummary } from '@/api/servers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const TYPE_LABEL: Record<string, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', velocity: 'Velocity' }

/** 多选服务器对话框:用于「安装/复制到其他服务器」类操作。 */
export function ServerPickerDialog({
  open,
  title,
  description,
  servers,
  disabledReason,
  busy,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  servers: ServerSummary[]
  disabledReason?: (server: ServerSummary) => string | undefined
  busy: boolean
  confirmLabel?: string
  onClose: () => void
  onConfirm: (ids: number[]) => void
}) {
  const [sel, setSel] = useState<Set<number>>(new Set())
  const selected = new Set(servers.filter((s) => sel.has(s.id) && !disabledReason?.(s)).map((s) => s.id))
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
                disabled={Boolean(disabledReason?.(s))}
                className="flex w-full items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => toggle(s.id)}
              >
                <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', selected.has(s.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
                  {selected.has(s.id) ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.name}{disabledReason?.(s) ? `（${disabledReason(s)}）` : ''}</span>
                <Badge variant="outline" className="text-[11px]">{TYPE_LABEL[s.server_type] ?? s.server_type}</Badge>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" className="gap-1.5" disabled={busy || selected.size === 0} onClick={() => onConfirm([...selected])}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirmLabel ?? `应用到 ${selected.size} 个`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
