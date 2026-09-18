@echo off
cd /d "%~dp0"
where node >nul 2>nul || goto NONODE
node "tools\import-assets.js" %*
echo.
pause
exit /b 0
:NONODE
echo.
echo   [!] Node.js not found.
echo   Install the LTS version from https://nodejs.org/ then run this again.
echo.
pause
exit /b 1
