import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { logError } from '@/lib/logger'
import { createResourceLoader } from './resource-loader'

export interface ResourceState<T> {
  data: T | null
  loading: boolean
  refreshing: boolean
  error: string | null
  refresh: () => void
  patch: (updater: (current: T) => T) => void
}
/** deps identify the resource. Forward signal to the API to cancel obsolete HTTP work.
 * Single flight is local to this hook; use a query cache for cross-component sharing.
 */
export function useResource<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: DependencyList = [], options: { keepPreviousData?: boolean } = {}): ResourceState<T> {
  const [data, setData] = useState<T | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reload = useRef<(() => void) | null>(null)
  const refresh = useCallback(() => reload.current?.(), [])
  const patch = useCallback((updater: (current: T) => T) => {
    setData(current => current === null ? current : updater(current))
  }, [])
  const keepPreviousData = options.keepPreviousData ?? false
  useEffect(() => {
    if (!keepPreviousData) setData(null)
    setError(null)
    const loader = createResourceLoader(fetcher, {
      start: () => { setRefreshing(true); setError(null) },
      success: result => { setData(result); setError(null) },
      failure: err => {
        const message = err instanceof Error ? err.message : '加载失败'
        setError(message)
        logError('resource.load_failed', { error: message })
      },
      finish: () => setRefreshing(false),
    })
    reload.current = loader.load
    loader.load()
    return () => { loader.dispose(); reload.current = null }
    // Resource identity is explicit; an inline fetcher changing alone must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepPreviousData, ...deps])
  return { data, loading: data === null && refreshing, refreshing, error, refresh, patch }
}
