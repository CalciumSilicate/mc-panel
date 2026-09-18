import { useRef, useState, type ReactNode } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ApiError } from '@/api/client'

export function QuickEdit({ label, value, display, disabled, options, password, onSave }: {
  label: string; value: string; display?: ReactNode; disabled?: boolean; password?: boolean
  options?: { value: string; label: string }[]; onSave: (value: string) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)
  const cancelled = useRef(false)
  const save = async (next = draft) => {
    if (saving.current || cancelled.current || disabled) return
    if (next === value && !password) { setOpen(false); return }
    saving.current = true; setBusy(true); setError('')
    try { await onSave(next); setOpen(false) }
    catch (err) { setError(err instanceof ApiError ? err.message : '保存失败') }
    finally { saving.current = false; setBusy(false) }
  }
  if (disabled) return <span>{display ?? (value || '—')}</span>
  if (!open) return <button type="button" aria-label={label} title="点击修改" className="-mx-1 rounded px-1 py-1 text-left hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => { cancelled.current = false; setDraft(password ? '' : value); setError(''); setOpen(true) }}>{display ?? (value || '—')}</button>
  return <div className="w-max max-w-72" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setOpen(false) } }}>
    {options ? <Select defaultOpen onOpenChange={(next) => { if (!next && !saving.current) setOpen(false) }} value={draft || '__default__'} onValueChange={(v) => { const next = v === '__default__' ? '' : v; setDraft(next); void save(next) }} disabled={busy}>
      <SelectTrigger autoFocus aria-label={label} className="h-8 w-32"><SelectValue /></SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value || '__default__'}>{o.label}</SelectItem>)}</SelectContent>
    </Select> : <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void save() }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) void save() }}>
      <Input autoFocus aria-label={label} type={password ? 'password' : 'text'} autoComplete={password ? 'new-password' : 'off'} value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }} className="h-8 w-36" />
      <button type="submit" aria-label="保存" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}</button>
      <button type="button" aria-label="取消" disabled={busy} onMouseDown={() => { cancelled.current = true }} onClick={() => { cancelled.current = true; setOpen(false) }}><X className="h-4 w-4" /></button>
    </form>}
    {error ? <p role="alert" className="mt-1 whitespace-normal text-xs text-destructive">{error}</p> : null}
  </div>
}
