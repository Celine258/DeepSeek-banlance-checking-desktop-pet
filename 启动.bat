@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DeepSeek Pet

where node >nul 2>nul
if errorlevel 1 goto NONODE

if exist "node_modules\electron" goto RUN

echo.
echo   First run: downloading dependencies, this takes a few minutes...
echo   (using a China mirror, no action needed)
echo.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 goto NPMFAIL

:RUN
echo.
echo   Starting DeepSeek Pet...
echo   (close this window to quit the pet)
echo.
call npm start
echo.
pause
exit /b 0

:NONODE
echo.
echo   [!] Node.js not found.
echo.
echo   Please install the LTS version from https://nodejs.org/
echo   then double-click this file again.
echo.
pause
exit /b 1

:NPMFAIL
echo.
echo   [!] npm install failed.
echo       Try another network, or run this first:
echo         npm config set registry https://registry.npmmirror.com
echo.
pause
exit /b 1
