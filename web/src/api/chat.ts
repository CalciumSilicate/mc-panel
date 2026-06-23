import { apiRequest, getAuthToken } from '@/api/client'

export interface ChatSegment {
  type: 'text' | 'image' | 'at' | 'face' | 'reply'
  text?: string
  url?: string
  qq?: string
  name?: string
  id?: string
  user?: string
}

export interface ChatMessage {
  source: 'mc' | 'qq' | 'web' | 'system'
  server?: string
  sender?: string
  sender_id?: string
  avatar?: string
  segments?: ChatSegment[]
  text: string
  ts: number
}

export interface ChatMember {
  name: string
  server?: string // 玩家所在服务器
  user_id?: string // QQ 号
  role?: string // owner / admin / member
}

export interface ChatMembers {
  players: ChatMember[]
  qq: ChatMember[]
}

export function chatWsUrl(groupId: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/chat/ws/${groupId}?token=${encodeURIComponent(getAuthToken())}`
}

export function sendChat(groupId: number, text: string) {
  return apiRequest(`/chat/${groupId}/send`, { method: 'POST', body: JSON.stringify({ text }) })
}

export function getChatMembers(groupId: number): Promise<ChatMembers> {
  return apiRequest<ChatMembers>(`/chat/${groupId}/members`)
}
