# Start development website and connect the independent MCDR host.
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$python = Join-Path $repo '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run uv sync first.' }
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$apiPort = if ($env:MCPANEL_API_PORT) { [int]$env:MCPANEL_API_PORT } else { 16824 }
$env:PYTHONPATH = Join-Path $repo 'backend'
$env:PYTHONUTF8 = '1'
$env:PATH = (Join-Path $repo '.venv\Scripts') + ';' + $env:PATH
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$statePath = Join-Path $logDir 'dev-processes.json'
$records = @()
if (Test-Path -LiteralPath $statePath) { $records = @(Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) }
function Test-Port([int]$port) {
    try { $socket = New-Object Net.Sockets.TcpClient; $socket.Connect('localhost', $port); $socket.Close(); return $true }
    catch { return $false }
}
function Save-Process($process, $kind) {
    $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
    $script:records += @{ pid = $entry.ProcessId; created = $entry.CreationDate.ToUniversalTime().ToString('o'); kind = $kind }
    ConvertTo-Json -InputObject @($script:records) | Set-Content -LiteralPath $statePath -Encoding utf8
}
& $python (Join-Path $repo 'runtime.py') start
if ($LASTEXITCODE -ne 0) { throw 'MCDR host failed to start. Check data/runtime/host.log.' }
if (Test-Port $apiPort) {
    Write-Host "Port $apiPort is already listening; backend was not started."
} else {
    $arguments = '-m watchfiles --filter python --target-type command "uvicorn app.main:app --host 127.0.0.1 --port ' + $apiPort + '" backend'
    $backend = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput "$logDir\backend.out.log" -RedirectStandardError "$logDir\backend.err.log"
    Save-Process $backend 'backend'
}
if (Test-Port 5278) {
    Write-Host 'Port 5278 is already listening; frontend was not started.'
} else {
    $frontend = Start-Process -FilePath $npm -ArgumentList 'run dev -- --strictPort' -WorkingDirectory (Join-Path $repo 'web') -PassThru -WindowStyle Hidden -RedirectStandardOutput "$logDir\frontend.out.log" -RedirectStandardError "$logDir\frontend.err.log"
    Save-Process $frontend 'frontend'
}
Write-Host "Website: http://localhost:5278  API: http://localhost:$apiPort"
Write-Host 'stop.cmd stops only the recorded website processes. MCDR remains running.'
