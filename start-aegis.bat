@echo off
rem ---------------------------------------------------------------------------
rem  Aegis API Client - one-click launcher (Windows)
rem
rem    start-aegis.bat            install (first run) + build (if needed) + launch
rem    start-aegis.bat rebuild    force a clean rebuild before launching
rem    start-aegis.bat dev        development mode (Vite dev server + hot reload)
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22.12 or newer is required but was not found on PATH.
  echo         Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

rem --- dependencies (first run) ---------------------------------------------
if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/3] Installing dependencies - this only happens once...
  call npm install
  if errorlevel 1 goto :fail
  if not exist "node_modules\electron\dist\electron.exe" (
    echo        Fetching the Electron runtime...
    call node node_modules\electron\install.js
    if errorlevel 1 goto :fail
  )
) else (
  echo [1/3] Dependencies already installed.
)

if /i "%~1"=="dev" (
  echo Starting in development mode...
  call npm run dev
  goto :end
)

rem --- build -----------------------------------------------------------------
set NEED_BUILD=0
if /i "%~1"=="rebuild" set NEED_BUILD=1
if not exist "dist\main\main.cjs" set NEED_BUILD=1
if not exist "dist\main\preload.cjs" set NEED_BUILD=1
if not exist "dist\renderer\index.html" set NEED_BUILD=1

if "%NEED_BUILD%"=="1" (
  echo [2/3] Building the application...
  call npm run build
  if errorlevel 1 goto :fail
) else (
  echo [2/3] Build is up to date - use "start-aegis.bat rebuild" to force a rebuild.
)

rem --- launch ----------------------------------------------------------------
echo [3/3] Launching Aegis API Client...
start "" "node_modules\electron\dist\electron.exe" .
goto :end

:fail
echo.
echo [ERROR] Setup failed - see the messages above.
pause
exit /b 1

:end
endlocal
