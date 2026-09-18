@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Import Character Assets

where node >nul 2>nul
if errorlevel 1 goto NONODE

node "tools\import-assets.js" %*
echo.
pause
exit /b 0

:NONODE
echo.
echo   [!] Node.js not found.
echo.
echo   Please install the LTS version from https://nodejs.org/
echo   then double-click this file again.
echo   See README.md for details.
echo.
pause
exit /b 1
