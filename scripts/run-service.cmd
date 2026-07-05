@echo off
cd /d "%~dp0.."
if not exist "logs" mkdir logs

:loop
node --use-env-proxy server.mjs >> logs\service-out.log 2>> logs\service-error.log
echo [%date% %time%] server exited, restart in 5s >> logs\service-error.log
timeout /t 5 /nobreak >nul
goto loop
