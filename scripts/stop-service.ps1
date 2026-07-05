# Stop BinaceSmart background service
$ErrorActionPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
cmd /c 'schtasks /Delete /TN BinaceSmart-Service /F' | Out-Null
cmd /c 'schtasks /Delete /TN BinaceSmart-PM2 /F' | Out-Null

$lines = netstat -ano | Select-String ':3388.*LISTENING'
foreach ($line in $lines) {
  $procId = ($line -split '\s+')[-1]
  if ($procId -match '^\d+$') { taskkill /PID $procId /F 2>$null | Out-Null }
}

# Stop node processes running server.mjs in this project
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'BinaceSmart\\server\.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host 'Stopped BinaceSmart service and removed autostart tasks'
