import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog'
import { MotionConfig } from 'motion/react'
import { claimChunkReload } from '@/lib/chunk-recovery'
import '@fontsource-variable/noto-sans-sc/wght.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ThemeProvider } from '@/components/theme'
import { GlobalToastProvider } from '@/components/ui/global-toast'
import { DialogProvider } from '@/components/ui/dialog-provider'
import { I18nProvider } from '@/i18n'
import { installBrowserErrorLogging, logError, logWarn } from '@/lib/logger'

import App from './App'
import './fonts.css'
import './index.css'

// 部署后 chunk 文件名(hash)会变,旧页面动态 import 旧 chunk 会 404。
// 监听 vite:preloadError,自动整页 reload 一次;用 sessionStorage 标记防止死循环。

if (typeof window !== 'undefined') {
  installBrowserErrorLogging()

  window.addEventListener('vite:preloadError', (event) => {
    if (!claimChunkReload(window.sessionStorage, import.meta.url)) {
      logError('vite.preload_failed_after_reload', { error: String(event) })
      return
    }

    event.preventDefault()
    logWarn('vite.preload_failed_reload', { error: String(event) })
    window.location.reload()
  })
}

// Provider 顺序:主题 → i18n → 全局 toast。
// GlobalToastProvider 依赖 useI18n,必须在 I18nProvider 之内。
createRoot(document.getElementById('root')!).render(
  <StrictMode><MotionConfig reducedMotion="user">
    <ThemeProvider>
      <I18nProvider>
        <GlobalToastProvider>
          <DialogProvider>
            <ConfirmDialogProvider><App /></ConfirmDialogProvider>
          </DialogProvider>
        </GlobalToastProvider>
      </I18nProvider>
    </ThemeProvider>
  </MotionConfig></StrictMode>,
)
