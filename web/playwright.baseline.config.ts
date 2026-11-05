import { defineConfig } from '@playwright/test'
const port = Number(process.env.BASELINE_PORT || 5286)
export default defineConfig({
  testDir: './baseline-tests', workers: 1, timeout: 45_000,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' },
  webServer: { command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort --mode development`, url: `http://127.0.0.1:${port}` },
})
