import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DataTableToolbar } from '@/components/layout/DataTableToolbar'
import { useConfirm } from '@/components/ui/use-confirm'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { nsKey } from '@/config'
export interface ResourceColumn<T> {
  id: string; label: string; value: (row: T) => string | number
  render?: (row: T) => ReactNode; align?: 'left' | 'right'
}
interface Props<T> {
  rows: T[]; columns: ResourceColumn<T>[]; rowId: (row: T) => string
  storageKey: string; columnVersion: number; selectionScope: string
  loading?: boolean; onDelete?: (ids: string[]) => Promise<void>
}
export function ResourceTable<T>({ rows, columns, rowId, storageKey, columnVersion, selectionScope, loading = false, onDelete }: Props<T>) {
  const confirm = useConfirm()
  const { showToast } = useGlobalToast()
  const key = nsKey(`${storageKey}:columns:v${columnVersion}`)
  const [visible, setVisible] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) || 'null')
      if (Array.isArray(stored) && stored.some(id => columns.some(c => c.id === id))) return stored.filter(id => columns.some(c => c.id === id))
    } catch { /* Use the complete default schema. */ }
    return columns.map(c => c.id)
  })
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<{ id: string; descending: boolean } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const shown = columns.filter(c => visible.includes(c.id))
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(visible)) } catch { /* Optional preference. */ } }, [key, visible])
  useEffect(() => { setSelected(new Set()); setPage(1) }, [selectionScope, search])
  useEffect(() => { setSelected(previous => {
    const next = new Set([...previous].filter(id => rows.some(row => rowId(row) === id)))
    return next.size === previous.size ? previous : next
  }) }, [rows, rowId])
  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN')
    const result = rows.filter(row => !keyword || columns.some(c => String(c.value(row)).toLocaleLowerCase('zh-CN').includes(keyword)))
    const column = columns.find(c => c.id === sort?.id)
    if (!column || !sort) return result
    return result.sort((a, b) => {
      const av = column.value(a), bv = column.value(b)
      const comparison = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true })
      return sort.descending ? -comparison : comparison
    })
  }, [rows, columns, search, sort])
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)))
  useEffect(() => { if (page !== currentPage) setPage(currentPage) }, [page, currentPage])
  const currentRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const selectedOnPage = currentRows.filter(row => selected.has(rowId(row))).length
  const togglePage = (checked: boolean) => setSelected(previous => {
    const next = new Set(previous)
    for (const row of currentRows) { if (checked) next.add(rowId(row)); else next.delete(rowId(row)) }
    return next
  })
  const remove = async () => {
    if (!onDelete || deleting) return
    if (!await confirm({ title: '删除所选记录', description: `将删除 ${selected.size} 条记录，此操作不可恢复。`, confirmText: '删除', variant: 'destructive' })) return
    setDeleting(true)
    try { await onDelete([...selected]); setSelected(new Set()); showToast('success', '所选记录已删除') } catch (error) { showToast('error', error instanceof Error ? error.message : '删除失败') } finally { setDeleting(false) }
  }
  return <div className="min-w-0" aria-busy={loading}>
    <DataTableToolbar searchValue={search} onSearchChange={setSearch} searchPlaceholder="搜索记录…"
      actions={<DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="outline" size="sm"><Columns3 />可见列</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">{columns.map(column =>
          <DropdownMenuCheckboxItem key={column.id} checked={visible.includes(column.id)} disabled={visible.length === 1 && visible.includes(column.id)}
            onSelect={event => event.preventDefault()} onCheckedChange={checked => setVisible(ids => checked ? [...ids, column.id] : ids.filter(id => id !== column.id))}>{column.label}</DropdownMenuCheckboxItem>)}</DropdownMenuContent>
      </DropdownMenu>} />
    {selected.size > 0 && <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
      <span>已选 {selected.size} 条</span>
      <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(filtered.map(rowId)))}>选择全部 {filtered.length} 条匹配记录</Button>
      <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>清除选择</Button>
      {onDelete && <Button variant="destructive" size="sm" disabled={deleting} onClick={() => { void remove() }}>{deleting ? '处理中…' : '删除所选'}</Button>}
    </div>}
    <Table className="min-w-[960px]"><TableHeader><TableRow>
      <TableHead className="w-10"><Checkbox aria-label="选择当前页" disabled={!currentRows.length}
        checked={selectedOnPage === 0 ? false : selectedOnPage === currentRows.length ? true : 'indeterminate'} onCheckedChange={checked => togglePage(checked === true)} /></TableHead>
      {shown.map(column => <TableHead key={column.id} className={column.align === 'right' ? 'text-right' : undefined}
        aria-sort={sort?.id === column.id ? sort.descending ? 'descending' : 'ascending' : 'none'}>
        <button type="button" className="inline-flex items-center gap-1" onClick={() => setSort(s => ({ id: column.id, descending: s?.id === column.id ? !s.descending : false }))}>
          {column.label}{sort?.id === column.id && (sort.descending ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
        </button></TableHead>)}
    </TableRow></TableHeader><TableBody>
      {currentRows.length ? currentRows.map(row => <TableRow key={rowId(row)} data-state={selected.has(rowId(row)) ? 'selected' : undefined}>
        <TableCell><Checkbox aria-label={`选择 ${rowId(row)}`} checked={selected.has(rowId(row))} onCheckedChange={checked => setSelected(previous => {
          const next = new Set(previous); if (checked) next.add(rowId(row)); else next.delete(rowId(row)); return next
        })} /></TableCell>
        {shown.map(column => <TableCell key={column.id} title={String(column.value(row))} className={column.align === 'right' ? 'text-right font-mono' : undefined}>
          <div className="truncate">{column.render ? column.render(row) : column.value(row)}</div>
        </TableCell>)}
      </TableRow>) : <TableRow><TableCell colSpan={shown.length + 1}><EmptyState title={loading ? '正在加载记录' : '没有匹配记录'} /></TableCell></TableRow>}
    </TableBody></Table>
    <div className="border-t px-3 py-3"><Pagination page={currentPage} pageSize={pageSize} total={filtered.length} onPageChange={setPage}
      onPageSizeChange={size => { setPageSize(size); setPage(1) }} /></div>
  </div>
}
