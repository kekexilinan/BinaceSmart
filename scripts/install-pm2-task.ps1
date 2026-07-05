# 注册静默开机自启（任务计划程序，无控制台闪烁）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'scripts\start-pm2-silent.vbs'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask `
  -TaskName 'BinaceSmart-PM2' `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'BinaceSmart PM2 silent autostart' `
  -Force | Out-Null

Write-Host 'Registered scheduled task: BinaceSmart-PM2 (silent at logon)'
