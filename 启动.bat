@echo off
cd /d "%~dp0"
where node >nul 2>nul || goto NONODE
if exist "node_modules\electron" goto RUN
echo.
echo   First run: downloading dependencies, takes a few minutes...
echo   (China mirror is used automatically)
echo.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
call npm install --registry=https://registry.npmmirror.com || goto NPMFAIL
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
echo   Install the LTS version from https://nodejs.org/ then run this again.
echo.
pause
exit /b 1
:NPMFAIL
echo.
echo   [!] npm install failed.
echo   Try: npm config set registry https://registry.npmmirror.com
echo.
pause
exit /b 1
