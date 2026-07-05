# 移除 PM2 开机自启
$ErrorActionPreference = 'SilentlyContinue'
schtasks /Delete /TN 'BinaceSmart-PM2' /F | Out-Null
Push-Location (Split-Path -Parent $PSScriptRoot)
pnpm exec pm2-startup uninstall 2>$null | Out-Null
Pop-Location
Write-Host '已移除 BinaceSmart-PM2 开机自启'
