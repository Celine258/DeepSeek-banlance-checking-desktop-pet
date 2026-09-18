@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Upload to GitHub

where git >nul 2>nul
if errorlevel 1 goto NOGIT

if exist ".git" goto UPDATE

echo.
echo   =========================================================
echo    First-time upload to GitHub
echo   =========================================================
echo.
echo   Step 1: create an EMPTY repository on GitHub.
echo.
echo           https://github.com/new
echo.
echo           IMPORTANT: do NOT let GitHub add a README,
echo           a .gitignore or a license. If the new repo is
echo           not empty, the first push will be rejected.
echo.
echo   Step 2: copy the repo URL
echo           (looks like https://github.com/you/repo.git)
echo.
set "REPOURL="
set /p "REPOURL=  Paste it here and press Enter: "
if "%REPOURL%"=="" goto NOURL

echo.
echo   Preparing local repository...
git init

rem use "main" as the branch name (works on any git version)
git symbolic-ref HEAD refs/heads/main

rem git needs to know who you are before it will let you commit
git config user.name >nul 2>nul
if errorlevel 1 git config user.name "celine"
git config user.email >nul 2>nul
if errorlevel 1 git config user.email "celine@users.noreply.github.com"

git remote remove origin >nul 2>nul
git remote add origin "%REPOURL%"

echo   Collecting files (node_modules is excluded)...
git add -A
git commit -m "Initial commit: DeepSeek balance desktop pet"
if errorlevel 1 goto COMMITFAIL

echo.
echo   Uploading. A browser window may pop up asking you to sign in.
echo.
git push -u origin main
if errorlevel 1 goto PUSHFAIL

echo.
echo   Done.
echo.
pause
exit /b 0

:UPDATE
echo.
echo   Repository already set up. Uploading changes...
echo.
git add -A
git commit -m "Update"
git push
echo.
echo   Done.
echo.
pause
exit /b 0

:NOGIT
echo.
echo   [!] Git is not installed.
echo.
echo   Download it from https://git-scm.com/download/win
echo   Install with the default options, then double-click
echo   this file again. (Restarting the Explorer helps.)
echo.
pause
exit /b 1

:NOURL
echo.
echo   [!] No URL given. Nothing was changed.
echo.
pause
exit /b 1

:COMMITFAIL
echo.
echo   [!] Commit failed. Usually this means git does not know
echo       your name or email yet. Run these two commands once:
echo.
echo         git config --global user.name  "your name"
echo         git config --global user.email "your@email.com"
echo.
pause
exit /b 1

:PUSHFAIL
echo.
echo   [!] Push failed.
echo.
echo   Most common cause: the GitHub repository is not empty
echo   (it already has a README or a license). Either delete
echo   that repo and create a new EMPTY one, or run:
echo.
echo         git pull --rebase origin main
echo         git push -u origin main
echo.
echo   Second most common cause: you were not signed in.
echo   Run the file again and complete the browser login.
echo.
pause
exit /b 1
