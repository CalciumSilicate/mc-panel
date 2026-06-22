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
  overwrite: boolean
}

export function applySuperflat(input: SuperflatApplyInput): Promise<{ generator_settings: string; overwritten: boolean }> {
  return apiRequest<{ generator_settings: string; overwritten: boolean }>('/tools/superflat/apply', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
