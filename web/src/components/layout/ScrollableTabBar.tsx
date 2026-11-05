import { useId, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
export interface ScrollableTabBarTab<T extends string> { key: T; label: string }
interface Props<T extends string> {
  tabs: ScrollableTabBarTab<T>[]; activeTab: T; onTabChange: (tab: T) => void; indicatorId: string
  showBorder?: boolean; outerClassName?: string; innerClassName?: string; buttonClassName?: string
}
export function ScrollableTabBar<T extends string>({ tabs, activeTab, onTabChange, indicatorId, showBorder = true, outerClassName, innerClassName, buttonClassName }: Props<T>) {
  const listId = useId()
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    onTabChange(tabs[next].key)
    document.getElementById(listId)?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }
  return <div className={cn('overflow-x-auto scrollbar-none', showBorder && 'border-b', outerClassName)}>
    <div id={listId} role="tablist" aria-label="页面分区" className={cn('flex min-w-max items-center gap-1', innerClassName)}>
      {tabs.map((tab, index) => <button key={tab.key} id={`${indicatorId}-${tab.key}`} type="button" role="tab"
        aria-selected={tab.key === activeTab} aria-controls={`${indicatorId}-panel`} tabIndex={tab.key === activeTab ? 0 : -1}
        onKeyDown={event => keyDown(event, index)} onClick={() => onTabChange(tab.key)}
        className={cn('ops-subnav-button', tab.key === activeTab ? 'ops-subnav-button-active' : 'ops-subnav-button-idle', buttonClassName)}>
        {tab.label}
      </button>)}
    </div>
  </div>
}
