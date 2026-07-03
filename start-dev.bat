@echo off
cd /d "%~dp0"
echo Starting BinaceSmart on http://localhost:3388 ...
node --use-env-proxy server.mjs
