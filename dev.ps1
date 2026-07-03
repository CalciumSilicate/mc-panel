# dev.ps1 - 一键启动 mc-panel(后端+前端),日志必落盘
$repo = $PSScriptRoot; if (-not $repo) { $repo = (Get-Location).Path }
New-Item -ItemType Directory -Force "$repo\logs" | Out-Null
Start-Transcript -Path "$repo\logs\launcher.log" -Force | Out-Null
try {
  $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source;  if (-not $uv)  { $uv  = "C:\Users\89366\.local\bin\uv.exe" }
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source; if (-not $npm) { $npm = "npm.cmd" }
  Write-Host "repo=$repo"; Write-Host "uv=$uv"; Write-Host "npm=$npm"
  function Test-Port($p){ try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',$p); $c.Close(); $true }catch{ $false } }

  if (Test-Port 16824) { Write-Host "[skip] 后端 16824 已在运行" -ForegroundColor Yellow }
  else {
    $env:PYTHONPATH = "$repo\backend"
    $be = Start-Process -FilePath $uv -ArgumentList 'run','uvicorn','app.main:app','--port','16824','--reload','--reload-dir','backend' `
      -WorkingDirectory $repo -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput "$repo\logs\backend.out.log" -RedirectStandardError "$repo\logs\backend.err.log"
    Write-Host "后端已启动 PID=$($be.Id)  日志: logs\backend.err.log" -ForegroundColor Cyan
  }

  if (Test-Port 5278) { Write-Host "[skip] 前端 5278 已在运行" -ForegroundColor Yellow }
  else {
    $fe = Start-Process -FilePath $npm -ArgumentList 'run','dev' `
      -WorkingDirectory "$repo\web" -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput "$repo\logs\frontend.out.log" -RedirectStandardError "$repo\logs\frontend.err.log"
    Write-Host "前端已启动 PID=$($fe.Id)  日志: logs\frontend.out.log" -ForegroundColor Cyan
  }

  Write-Host -NoNewline "等待前端就绪 "
  for ($i=0; $i -lt 60; $i++){ if (Test-Port 5278){ break }; Start-Sleep -Milliseconds 500; Write-Host -NoNewline "." }
  Write-Host ""
  if (Test-Port 5278) { Start-Process "http://localhost:5278"; Write-Host "OK -> http://localhost:5278 (密码 admin)" -ForegroundColor Green }
  else { Write-Host "前端 30s 没起,看 logs\frontend.err.log / frontend.out.log" -ForegroundColor Yellow }

  if (Test-Port 16824) { Write-Host "后端健康: 16824 在监听" -ForegroundColor Green }
  else { Write-Host "后端没起,看 logs\backend.err.log" -ForegroundColor Yellow }
} catch {
  Write-Host "[启动器异常] $_" -ForegroundColor Red
} finally {
  Stop-Transcript | Out-Null
}
Write-Host "服务在后台运行(隐藏窗口),日志在 logs\ 下。停止请运行 stop.cmd。"
