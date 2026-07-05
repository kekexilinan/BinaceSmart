@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  [提示] 已启用后台常驻服务
echo  安装/重启: pnpm service:install
echo  停止服务: pnpm service:stop
echo  查看日志: pnpm service:logs
echo.
echo  前台调试 (Ctrl+C 退出):
node dev-restart.mjs
