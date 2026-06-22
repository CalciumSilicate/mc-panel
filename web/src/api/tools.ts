import { apiRequest } from '@/api/client'

/** 超平坦世界生成器。 */
export interface SuperflatLayer {
  block: string
  height: number
}

export interface SuperflatApplyInput {
  server_id: number
  layers: SuperflatLayer[]
  biome: string
  structures: string[]
  generate_structures: boolean
  overwrite: boolean
}

export function applySuperflat(input: SuperflatApplyInput): Promise<{ data_version: number; format: string; mc_version: string }> {
  return apiRequest<{ data_version: number; format: string; mc_version: string }>('/tools/superflat/apply', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
