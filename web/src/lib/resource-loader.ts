/** Single flight per loader, one trailing refresh, and useful results during continuous polling. */
export function createResourceLoader<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  callbacks: { start: () => void; success: (data: T) => void; failure: (error: unknown) => void; finish: () => void },
) {
  let disposed = false
  let running = false
  let queued = false
  let controller: AbortController | undefined
  const load = async () => {
    if (disposed) return
    if (running) { queued = true; return }
    running = true
    do {
      queued = false
      controller = new AbortController()
      callbacks.start()
      try {
        const result = await fetcher(controller.signal)
        if (!disposed) callbacks.success(result)
      } catch (error) {
        if (!disposed && !controller.signal.aborted) callbacks.failure(error)
      } finally {
        if (!disposed) callbacks.finish()
      }
    } while (queued && !disposed)
    running = false
  }
  return {
    load: () => { void load() },
    dispose: () => { disposed = true; queued = false; controller?.abort() },
  }
}
