@echo off
setlocal
cd /d "%~dp0"
title QQRT 服务端

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\nodejs\node.exe" set "NODE_EXE=%USERPROFILE%\nodejs\node.exe"
if not defined NODE_EXE if exist "C:/Program Files/nodejs/node.exe" set "NODE_EXE=C:/Program Files\nodejs\node.exe"
if not defined NODE_EXE goto NONODE

echo ============================================
echo    QQRT 服务端
echo ============================================
echo.
echo    本机浏览器:   http://127.0.0.1:3005
echo    模拟器里填:   http://10.0.2.2:3005
echo    手环里填:     http://192.168.3.17:3005
echo.
echo    关闭本窗口 = 停止服务
echo ============================================
echo.

"%NODE_EXE%" run-all.mjs
set "CODE=%ERRORLEVEL%"
echo.
echo 服务已退出，退出码 %CODE%
pause
exit /b %CODE%

:NONODE
echo [错误] 找不到 node.exe
echo.
echo 请安装 Node.js（https://nodejs.org）后重试，
echo 或确认 C:/Users/%USERNAME%/nodejs/node.exe 存在。
echo.
pause
exit /b 1
