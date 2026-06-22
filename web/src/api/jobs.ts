import { apiRequest } from '@/api/client'

/** 安装任务进度(插件/模组在线安装)。 */
export interface JobState {
  downloaded: number
  total: number
  status: 'running' | 'done' | 'error'
  message: string
  file_name: string
}

export function getJob(jobId: string): Promise<JobState> {
  return apiRequest<JobState>(`/jobs/${jobId}`)
}

/** 轮询任务直到结束;onProgress 返回 0-100 百分比(总量未知时为 null)。 */
export async function pollJob(
  jobId: string,
  onProgress: (percent: number | null) => void,
  intervalMs = 400,
): Promise<JobState> {
  for (;;) {
    const job = await getJob(jobId)
    onProgress(job.total > 0 ? Math.round((job.downloaded / job.total) * 100) : null)
    if (job.status !== 'running') return job
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
