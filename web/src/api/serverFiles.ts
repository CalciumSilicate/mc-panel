import { apiRequest } from '@/api/client'

export interface ServerFileEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'blocked'
  size_bytes: number | null
  modified_at: string | null
  revision: string | null
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
  entry_revision: string
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

export function createServerEntry(id: number, directory: string, name: string, kind: 'file' | 'directory') {
  return apiRequest<{ path: string }>(`/servers/${id}/files/entry`, {
    method: 'POST', body: JSON.stringify({ directory, name, kind }),
  })
}

export function renameServerEntry(id: number, entry: ServerFileEntry, name: string) {
  return apiRequest<{ path: string }>(`/servers/${id}/files/entry`, {
    method: 'PATCH', body: JSON.stringify({ path: entry.path, revision: entry.revision, name }),
  })
}

export function deleteServerEntry(id: number, entry: ServerFileEntry) {
  return apiRequest<{ job_id: string }>(`/servers/${id}/files/entry`, {
    method: 'DELETE', body: JSON.stringify({ path: entry.path, revision: entry.revision }),
  })
}
