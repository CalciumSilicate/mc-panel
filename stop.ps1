# 停止 mc-panel 开发服务(后端 watchfiles+uvicorn 整树 + 前端 vite)。
# 不动被托管的 MCDR 实例(停面板不等于关游戏服)。

# 1) 后端:按命令行匹配 mc-panel 的 watchfiles / uvicorn,连子进程一起杀(整树)
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('watchfiles.exe', 'uvicorn.exe', 'python.exe') -and
  $_.CommandLine -match 'mc-panel.*(watchfiles|uvicorn|app\.main)'
} | ForEach-Object {
  try { taskkill /F /T /PID $_.ProcessId 2>$null | Out-Null; Write-Host "已停止后端 PID$($_.ProcessId)" } catch {}
}

# 2) 端口兜底:仍在监听 16824 / 5278 的进程(前端 vite 等)
foreach ($p in 16824, 5278) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.OwningProcess -Force; Write-Host "已停止 端口$p PID$($_.OwningProcess)" } catch {}
  }
}
Write-Host "done"
