@echo off
cd /d "%~dp0.."
set PM2_HOME=%USERPROFILE%\.pm2

if not exist "node_modules\.bin\pm2.cmd" exit /b 1

call node_modules\.bin\pm2.cmd ping >nul 2>&1
if errorlevel 1 (
  call node_modules\.bin\pm2.cmd start ecosystem.config.cjs --update-env
) else (
  call node_modules\.bin\pm2.cmd resurrect
)
