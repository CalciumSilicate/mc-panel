foreach ($p in 16824,5278) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.OwningProcess -Force; Write-Host "已停止 端口$p PID$($_.OwningProcess)" } catch {}
  }
}
Write-Host "done"
