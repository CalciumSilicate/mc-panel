import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGlobalToast } from '@/components/ui/use-global-toast'
export function CopyCell({ value }: { value: string }) {
  const { showToast } = useGlobalToast()
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); showToast('success', '已复制') }
    catch { showToast('error', '复制失败，请手动复制') }
  }
  return <span className="flex min-w-0 items-center gap-1">
    <span title={value} className="truncate font-mono">{value}</span>
    <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label={`复制 ${value}`} onClick={copy}><Copy className="h-3 w-3" /></Button>
  </span>
}
