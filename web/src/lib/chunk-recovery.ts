import { nsKey } from '@/config'
/** One reload per build in a five-minute window, retained across load events. */
export function claimChunkReload(storage: Pick<Storage, 'getItem' | 'setItem'>, build: string, now = Date.now()): boolean {
  const key = nsKey('chunk-recovery')
  try {
    const previous = JSON.parse(storage.getItem(key) || 'null') as { build?: string; at?: number } | null
    if (previous?.build === build && typeof previous.at === 'number' && now - previous.at < 300_000) return false
    storage.setItem(key, JSON.stringify({ build, at: now }))
    return true
  } catch { return false }
}
