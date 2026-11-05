import { Check, ChevronsUpDown, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import type { SelectOption } from '@/components/ui/option-types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface MultiSelectProps {
  allowCustom?: (value: string) => boolean
  customLabel?: string
  id?: string
  'aria-label'?: string
  options: SelectOption[]
  value: string[]
  onValueChange: (value: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  maxPreviewItems?: number
  disabled?: boolean
  className?: string
  contentClassName?: string
}

export function MultiSelect({
  allowCustom,
  customLabel = '添加',
  id,
  'aria-label': ariaLabel,
  options,
  value,
  onValueChange,
  placeholder = '请选择',
  searchPlaceholder = '搜索...',
  emptyText = '没有匹配选项',
  maxPreviewItems = 3,
  disabled = false,
  className,
  contentClassName,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const allOptions = useMemo<SelectOption[]>(() => [
    ...options,
    ...value.filter(item => allowCustom?.(item) && !options.some(option => option.value === item)).map(item => ({ value: item, label: item })),
  ], [allowCustom, options, value])
  const customValue = search.trim()
  const canCreate = Boolean(customValue && allowCustom?.(customValue) && !allOptions.some(option => option.value === customValue))
  const selectedOptions = useMemo(() => allOptions.filter((option) => value.includes(option.value)), [allOptions, value])
  const selectedSet = useMemo(() => new Set(value), [value])
  const visibleOptions = selectedOptions.slice(0, maxPreviewItems)
  const overflowCount = Math.max(selectedOptions.length - visibleOptions.length, 0)

  const toggleValue = (nextValue: string) => {
    if (selectedSet.has(nextValue)) {
      onValueChange(value.filter((item) => item !== nextValue))
      return
    }
    onValueChange([...value, nextValue])
  }

  const clearAll = () => {
    onValueChange([])
  }

  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setSearch('') }}>
      <div className="flex items-center gap-2">
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          id={id}
          aria-label={ariaLabel}
          aria-expanded={open}
          disabled={disabled}
          className={cn('min-h-9 h-auto w-full justify-between px-3 py-1.5 font-normal', !selectedOptions.length && 'text-muted-foreground', className)}
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {selectedOptions.length ? (
              <>
                {visibleOptions.map((option) => (
                  <Badge key={option.value} variant="secondary" className="max-w-[11rem] gap-1 pr-1">
                    <span className="truncate">{option.label}</span>

                  </Badge>
                ))}
                {overflowCount ? <Badge variant="outline">+{overflowCount}</Badge> : null}
              </>
            ) : (
              <span className="truncate">{placeholder}</span>
            )}
          </span>
          <span className="ml-2 flex shrink-0 items-center gap-1">
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      {selectedOptions.length > 0 && <Button type="button" variant="ghost" size="icon" disabled={disabled} onClick={clearAll} aria-label="清空选择"><X className="h-4 w-4" /></Button>}
      </div>
      <PopoverContent className={cn('w-[--radix-popover-trigger-width] p-0', contentClassName)} align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[min(60vh,320px)] overscroll-contain" onWheel={event => event.stopPropagation()}>
            {!canCreate && <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup forceMount={canCreate}>
              {allOptions.map((option) => {
                const selected = selectedSet.has(option.value)
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[option.label, option.description || '', ...(option.keywords || [])]}
                    disabled={option.disabled}
                    onSelect={() => toggleValue(option.value)}
                  >
                    <Check className={cn('h-4 w-4', selected ? 'opacity-100' : 'opacity-0')} />
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.label}</span>
                        {option.description ? <span className="block truncate text-xs text-muted-foreground">{option.description}</span> : null}
                      </span>
                    </span>
                  </CommandItem>
                )
              })}
              {canCreate && <CommandItem value={customValue} forceMount onSelect={() => { toggleValue(customValue); setSearch('') }}>{customLabel}：{customValue}</CommandItem>}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
