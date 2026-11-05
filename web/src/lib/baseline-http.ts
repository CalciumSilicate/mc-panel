import { nsKey } from '@/config'
export const BASELINE_SESSION_EXPIRED = nsKey('baseline-session-expired')
export function notifyUnauthorized(response: Response) {
  if (response.status !== 401) return
  try { localStorage.removeItem(nsKey('auth-token')) } catch { /* Session UI must still expire. */ }
  window.dispatchEvent(new Event(BASELINE_SESSION_EXPIRED))
}
export function mergeApiHeaders(defaults: HeadersInit, extra?: HeadersInit, body?: BodyInit | null): Headers {
  const headers = new Headers(defaults)
  if (typeof body !== 'string') headers.delete('content-type')
  new Headers(extra).forEach((value, key) => headers.set(key, value))
  if (body instanceof FormData && !new Headers(extra).has('content-type')) headers.delete('content-type')
  return headers
}
export async function readApiPayload(response: Response, method = 'GET', expire = true) {
  if (expire) notifyUnauthorized(response)
  const text = await response.text()
  if (!text.trim()) {
    if (!response.ok || response.status === 204 || response.status === 205 || method === 'HEAD') return undefined
    throw new Error('服务器返回了空响应，请检查 API 服务。')
  }
  try { return JSON.parse(text) } catch {
    if (!response.ok) return { error: text.trim().startsWith('<') ? 'HTTP ' + response.status : text.slice(0, 500) }
    throw new Error('服务器未返回有效 JSON，请检查 API 地址或反向代理。')
  }
}
