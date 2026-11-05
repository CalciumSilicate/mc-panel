import { useEffect } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  className?: string
}

function clampPage(page: number, pageCount: number) {
  return Math.min(Math.max(page, 1), Math.max(pageCount, 1))
}

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, className }: PaginationProps) {
  const pageCount = Math.max(Math.ceil(total / Math.max(1, pageSize)), 1)
  const currentPage = clampPage(page, pageCount)
  useEffect(() => { if (page !== currentPage) onPageChange(currentPage) }, [page, currentPage, onPageChange])
  const start = total === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const end = Math.min(currentPage * pageSize, total)

  return (
    <div className={cn('flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between', className)}>
      <div>
        共 <span className="font-medium text-foreground">{total}</span> 条
        {total ? (
          <>
            , 当前 <span className="font-medium text-foreground">{start}-{end}</span>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange && <Select value={String(pageSize)} onValueChange={value => onPageSizeChange(Number(value))}>
          <SelectTrigger aria-label="每页条数" className="h-8 w-28"><SelectValue /></SelectTrigger>
          <SelectContent>{[10, 20, 50, 100].map(size => <SelectItem key={size} value={String(size)}>{size} 条/页</SelectItem>)}</SelectContent>
        </Select>}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
          上一页
        </Button>
        <div className="min-w-16 text-center text-xs">
          {currentPage} / {pageCount}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={currentPage >= pageCount}
          onClick={() => onPageChange(currentPage + 1)}
        >
          下一页
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
