import { apiRequest, getAuthToken } from '@/api/client'

export interface ChatMessage {
  source: 'mc' | 'qq' | 'web' | 'system'
  server?: string
  player?: string
  user?: string
  text: string
  ts: number
}

export function chatWsUrl(groupId: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/chat/ws/${groupId}?token=${encodeURIComponent(getAuthToken())}`
}

export function sendChat(groupId: number, text: string) {
  return apiRequest(`/chat/${groupId}/send`, { method: 'POST', body: JSON.stringify({ text }) })
}
