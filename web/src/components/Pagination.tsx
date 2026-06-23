import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'

/** 分页器:显示总数 + 上一页/下一页 + 页码。总数 <= 一页时不显示翻页。 */
export function Pagination({ page, pageCount, total, onPage }: { page: number; pageCount: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null
  return (
    <div className="flex items-center justify-between px-1 pt-3 text-xs text-muted-foreground">
      <span>共 {total} 条</span>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>{page} / {pageCount}</span>
          <Button type="button" variant="outline" size="icon" className="h-7 w-7" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
