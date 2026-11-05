import { useEffect, useRef, type ReactNode } from 'react'
import { ScrollableTabBar } from '@/components/layout/ScrollableTabBar'
import { PageShell } from '@/components/layout/PageScaffold'
import { useGlobalToast } from '@/components/ui/use-global-toast'
export interface TabbedSettingsPageTab<T extends string> { key: T; label: string }
interface TabbedSettingsPageProps<T extends string> {
  title: string; description?: string; tabs: TabbedSettingsPageTab<T>[]; activeTab: T
  onTabChange: (tab: T) => void; indicatorId: string; children: ReactNode
  /** Compatibility only. Prefer showing a toast in the completion handler. A new object is a new event. */
  message?: { type: 'success' | 'error'; text: string } | null
  extraContent?: ReactNode; headerActions?: ReactNode
}
export function TabbedSettingsPage<T extends string>({ title, description, tabs, activeTab, onTabChange, indicatorId, children, message, extraContent, headerActions }: TabbedSettingsPageProps<T>) {
  const { showToast } = useGlobalToast()
  const lastMessage = useRef<typeof message>(null)
  useEffect(() => {
    if (message && lastMessage.current !== message) showToast(message.type, message.text)
    lastMessage.current = message
  }, [message, showToast])
  return <PageShell title={title} description={description} actions={headerActions}>
    <ScrollableTabBar tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} indicatorId={indicatorId} />
    {extraContent}
    <div role="tabpanel" id={`${indicatorId}-panel`} aria-labelledby={`${indicatorId}-${activeTab}`} className="space-y-6">{children}</div>
  </PageShell>
}
