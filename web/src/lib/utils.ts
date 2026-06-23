import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 把后端的 epoch 秒格式化为「上次刷新 HH:MM:SS」,无值显示「—」。 */
export function fmtRefreshed(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return '上次刷新 —'
  const d = new Date(epochSeconds * 1000)
  return `上次刷新 ${d.toLocaleTimeString()}`
}
