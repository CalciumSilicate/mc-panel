import { apiRequest, getAuthToken } from '@/api/client'
import { nsKey } from '@/config'

export interface ImportOptions {
  name: string
  server_type: 'vanilla' | 'fabric' | 'forge' | 'velocity'
  mc_version: string
  port: number
  min_memory: string
  max_memory: string
  launch_jar: string
}

export interface UploadTarget {
  kind: 'file' | 'package'
  server_id?: number
  directory?: string
  overwrite?: boolean
  options?: ImportOptions
}

export interface UploadState {
  id: string
  name: string
  size: number
  received: number
  status: 'uploading' | 'processing' | 'done' | 'error'
  stage: string
  processed: number
  total: number
  message: string
  server_id: number | null
  chunk_bytes: number
}

function sendChunk(id: string, offset: number, chunk: Blob, digest: string, signal: AbortSignal, onProgress: (bytes: number) => void): Promise<UploadState> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => { xhr.abort(); reject(new DOMException('已暂停', 'AbortError')) }
    xhr.open('PUT', `/api/uploads/${id}/chunks?offset=${offset}`)
    xhr.setRequestHeader('authorization', `Bearer ${getAuthToken()}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    if (digest) xhr.setRequestHeader('x-chunk-sha256', digest)
    xhr.timeout = 45000
    xhr.upload.onprogress = (event) => onProgress(event.loaded)
    xhr.onload = () => {
      let payload
      try { payload = JSON.parse(xhr.responseText) } catch { reject(new Error(`上传失败 HTTP ${xhr.status}`)); return }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload)
      else reject(new Error(payload.error || `上传失败 HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('上传连接中断'))
    xhr.ontimeout = () => reject(new Error('分片上传超时'))
    xhr.onabort = () => reject(new DOMException('已暂停', 'AbortError'))
    xhr.onloadend = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else xhr.send(chunk)
  })
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('已暂停', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** File bytes are sent in bounded requests; completion only queues background work. */
export async function uploadFile(file: File, target: UploadTarget, onProgress: (state: UploadState) => void, signal: AbortSignal): Promise<UploadState> {
  const key = nsKey(`upload:${JSON.stringify([target, file.name, file.size, file.lastModified])}`)
  const saved = localStorage.getItem(key)
  let state: UploadState | undefined
  if (saved) {
    try { state = await apiRequest<UploadState>(`/uploads/${saved}`, { signal }) }
    catch (error) {
      if (signal.aborted) throw error
      // Only an absent/expired task can be replaced; transient network failures
      // must not silently duplicate a possibly completed import.
      if (!(error instanceof Error) || !('status' in error) || error.status !== 404) throw error
      localStorage.removeItem(key)
    }
  }
  if (!state) {
    state = await apiRequest<UploadState>('/uploads', { method: 'POST', signal, body: JSON.stringify({ ...target, name: file.name, size: file.size }) })
    localStorage.setItem(key, state.id)
  }
  onProgress(state)
  while (state.status === 'uploading' && state.received < file.size) {
    const offset = state.received
    const chunk = file.slice(offset, offset + state.chunk_bytes)
    const digest = globalThis.crypto?.subtle
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await chunk.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('')
      : ''
    let failure: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const current = state
        state = await sendChunk(state.id, offset, chunk, digest, signal, bytes => onProgress({ ...current, received: offset + bytes }))
        failure = undefined
        break
      } catch (error) {
        if (signal.aborted) throw error
        failure = error
        if (attempt < 2) await delay(750 * (attempt + 1), signal)
      }
    }
    if (failure) throw failure
    onProgress(state)
  }
  if (state.status === 'uploading') {
    state = await apiRequest<UploadState>(`/uploads/${state.id}/complete`, { method: 'POST', signal })
  }
  while (state.status === 'processing') {
    onProgress(state)
    await delay(750, signal)
    state = await apiRequest<UploadState>(`/uploads/${state.id}`, { signal })
  }
  onProgress(state)
  if (state.status === 'error') {
    localStorage.removeItem(key)
    await apiRequest(`/uploads/${state.id}`, { method: 'DELETE' }).catch(() => {})
    throw new Error(state.message || '处理失败')
  }
  localStorage.removeItem(key)
  await apiRequest(`/uploads/${state.id}`, { method: 'DELETE' }).catch(() => {})
  return state
}
