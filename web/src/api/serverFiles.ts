import { apiRequest } from '@/api/client'

export interface ServerFileEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'blocked'
  size_bytes: number | null
  modified_at: string | null
  reason?: string
}

export interface ServerDirectory {
  path: string
  entries: ServerFileEntry[]
}

export interface ServerFileContent {
  path: string
  text: string
  revision: string
  editable: boolean
  reason?: string
  bom: boolean
  newline: 'LF' | 'CRLF' | 'CR' | 'mixed'
  size_bytes: number
  modified_at: string
}

export function listServerFiles(id: number, path: string, signal?: AbortSignal) {
  return apiRequest<ServerDirectory>(`/servers/${id}/files?path=${encodeURIComponent(path)}`, { signal })
}

export function readServerFile(id: number, path: string, signal?: AbortSignal) {
  return apiRequest<ServerFileContent>(`/servers/${id}/files/content?path=${encodeURIComponent(path)}`, { signal })
}

export function saveServerFile(id: number, file: ServerFileContent, text: string) {
  return apiRequest<ServerFileContent>(`/servers/${id}/files/content`, {
    method: 'PUT',
    body: JSON.stringify({ path: file.path, text, revision: file.revision }),
  })
}
