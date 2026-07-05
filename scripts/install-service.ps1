# Install BinaceSmart as hidden Windows background service (no PM2)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'scripts\start-service-silent.vbs'

$ErrorActionPreference = 'SilentlyContinue'
cmd /c 'schtasks /Delete /TN BinaceSmart-PM2 /F' | Out-Null
$ErrorActionPreference = 'Stop'

# Kill existing server on 3388
$lines = netstat -ano | Select-String ':3388.*LISTENING'
foreach ($line in $lines) {
  $procId = ($line -split '\s+')[-1]
  if ($procId -match '^\d+$') {
    try { Stop-Process -Id ([int]$procId) -Force -ErrorAction Stop } catch {}
  }
}

# Register logon task
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask `
  -TaskName 'BinaceSmart-Service' `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'BinaceSmart hidden background service' `
  -Force | Out-Null

# Start now
Start-Process 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
Start-Sleep -Seconds 3

Write-Host 'Installed: BinaceSmart-Service (hidden, no PM2)'
Write-Host 'Logs: logs/service-out.log, logs/service-error.log'
