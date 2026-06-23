import { useEffect, useMemo, useState } from 'react'

/** 分页 hook:默认每页 20。返回当前页切片与控制。 */
export function usePaged<T>(items: T[], pageSize = 20) {
  const [page, setPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  useEffect(() => {
    if (page > pageCount) setPage(1)
  }, [page, pageCount])
  const pageItems = useMemo(
    () => items.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
    [items, page, pageSize],
  )
  return { page, setPage, pageCount, total: items.length, pageItems }
}
