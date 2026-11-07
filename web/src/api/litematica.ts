import type { ModelAssets } from '@/lib/block-models'
import type { EntityLayers } from '@/lib/entity-geometry'
import type { PreviewEntity } from '@/lib/entity-models'
import { ApiError, apiRequest, apiUpload, getAuthToken } from '@/api/client'

export interface LitematicaFile {
  name: string
  size_bytes: number
  info?: LitematicaInfo | null
}

export interface Material {
  id: string
  count: number
}

export interface LitematicaInfo {
  regions: number
  size: [number, number, number]
  total_blocks: number
  materials: Material[]
}

export function listLitematica(): Promise<LitematicaFile[]> {
  return apiRequest<LitematicaFile[]>('/litematica')
}

export function uploadLitematica(file: File): Promise<{ name: string }> {
  const fd = new FormData()
  fd.append('file', file)
  return apiUpload('/litematica/upload', fd)
}

export function getLitematicaInfo(name: string): Promise<LitematicaInfo> {
  return apiRequest<LitematicaInfo>(`/litematica/${encodeURIComponent(name)}/info`)
}

export function deleteLitematica(name: string): Promise<{ ok: boolean }> {
  return apiRequest(`/litematica/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function downloadLitematica(name: string): Promise<void> {
  const res = await fetch(`/api/litematica/${encodeURIComponent(name)}/download`, {
    headers: { authorization: `Bearer ${getAuthToken()}` },
  })
  if (!res.ok) throw new ApiError('下载失败', res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}


export interface LitematicaPreview {
  origin: [number, number, number]
  size: [number, number, number]
  regions: { name: string; origin: number[]; size: number[] }[]
  palette: string[]
  block_states?: { id: string; properties: Record<string, string> }[]
  blocks: [number, number, number, number][]
  total_blocks: number
  sampled: boolean
  layer: number | null
  entities?: PreviewEntity[]
  block_entities?: {position: [number,number,number]; data:Record<string,unknown>}[]
  total_entities?: number
  entities_sampled?: boolean
}

export function getLitematicaPreview(name: string, layer: number | null, region: string, signal?: AbortSignal): Promise<LitematicaPreview> {
  const params = new URLSearchParams()
  if (layer !== null) params.set('layer', String(layer))
  if (region) params.set('region', region)
  return apiRequest(`/litematica/${encodeURIComponent(name)}/preview?${params}`, { signal })
}


export async function getBlockModelAssets(signal: AbortSignal): Promise<ModelAssets> {
  const response = await fetch('/blocks/models/definitions.json', { signal })
  if (!response.ok) throw new Error('方块模型加载失败')
  return response.json()
}

export async function getEntityModelAssets(signal: AbortSignal): Promise<EntityLayers> {
  const response=await fetch('/blocks/models/entities.json',{signal})
  if(!response.ok)throw new Error('实体模型加载失败')
  return response.json()
}

export async function getPreviewSkin(hash:string,signal:AbortSignal):Promise<Blob> {
  if(!/^[a-f0-9]{32,64}$/.test(hash))throw new Error('无效的皮肤纹理')
  const response=await fetch(`/api/litematica/skins/${hash}`,{signal,headers:{authorization:`Bearer ${getAuthToken()}`}})
  if(!response.ok)throw new Error('皮肤加载失败')
  return response.blob()
}
