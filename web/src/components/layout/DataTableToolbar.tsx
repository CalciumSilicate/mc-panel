import type { ReactNode } from 'react'
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface DataTableToolbarProps {
  title?: string
  description?: string
  searchValue?: string
  onSearchChange?: (value: string) => void
  searchPlaceholder?: string
  filters?: ReactNode
  actions?: ReactNode
  className?: string
}

export function DataTableToolbar({
  title,
  description,
  searchValue,
  onSearchChange,
  searchPlaceholder = '搜索...',
  filters,
  actions,
  className,
}: DataTableToolbarProps) {
  return (
    <div className={cn('flex flex-col gap-3 border-b border-border/70 px-5 py-4', className)}>
      {title || description ? (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-1">
            {title ? <h3 className="text-sm font-semibold text-foreground">{title}</h3> : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
        </div>
      ) : null}
      {onSearchChange || filters || actions ? (
        <div className="flex flex-wrap items-center gap-3">
          {onSearchChange ? (
            <div className="relative min-w-40 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchValue || ''}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="pl-9"
              />
            </div>
          ) : null}
          {filters ? <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 lg:justify-end">{filters}</div> : null}
          {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
