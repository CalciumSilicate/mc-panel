# Stop only website processes recorded by dev.ps1. Never kill by port or kill a whole tree.
$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot 'logs\dev-processes.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Host 'No recorded development website processes. MCDR host left running.'
    return
}
$records = @(Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)
$processes = @(Get-CimInstance Win32_Process)
function Stop-WebsiteBranch($process) {
    # Exclude host/instance subtrees even if a previous launcher attached them here.
    if ($process.CommandLine -match 'app\.runtime_host|runtime\.py|mcdreforged' -or $process.Name -match '^java(w)?\.exe$') { return }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)" -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate -eq $process.CreationDate) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped website PID $($process.ProcessId)"
    }
    # Stop the watcher before its children so it cannot spawn replacements.
    foreach ($child in $processes | Where-Object { $_.ParentProcessId -eq $process.ProcessId -and $_.CreationDate -ge $process.CreationDate }) {
        Stop-WebsiteBranch $child
    }
}
foreach ($record in $records) {
    $process = $processes | Where-Object { $_.ProcessId -eq $record.pid }
    if ($process -and $process.CreationDate.ToUniversalTime().ToString('o') -eq $record.created) { Stop-WebsiteBranch $process }
}
Remove-Item -LiteralPath $statePath
Write-Host 'Website stopped. MCDR host and game instances remain running.'
