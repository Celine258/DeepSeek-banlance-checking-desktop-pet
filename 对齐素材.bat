@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Align Character Assets

where node >nul 2>nul
if errorlevel 1 goto NONODE

node "tools\import-assets.js" --align %*
echo.
pause
exit /b 0

:NONODE
echo.
echo   [!] Node.js not found.
echo.
echo   Please install the LTS version from https://nodejs.org/
echo.
pause
exit /b 1
