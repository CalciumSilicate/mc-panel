import type { ServerStatus } from '@/api/servers'

/** 服务器状态的显示元数据(标签 + 配色),供仪表盘与服务器列表共用。 */
export const SERVER_STATUS_META: Record<ServerStatus, { label: string; tone: string }> = {
  starting: {
    label: '启动中',
    tone: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  running: {
    label: '运行中',
    tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  stopped: {
    label: '已停止',
    tone: 'border-border/70 bg-muted text-muted-foreground',
  },
  installing: {
    label: '安装中',
    tone: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  new_setup: {
    label: '待安装',
    tone: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
  error: {
    label: '异常',
    tone: 'border-destructive/35 bg-destructive/10 text-destructive',
  },
}
