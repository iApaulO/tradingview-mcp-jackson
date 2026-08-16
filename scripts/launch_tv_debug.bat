@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Auto-detect TradingView install location FIRST. The original script killed the running instance
REM before locating the exe, so a detection failure left the user with no TradingView at all.
set "TV_EXE="

REM Check common install locations
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM Check MSIX / Windows Store installs.
REM NOTE 2026-08-16: the plain `dir` scan below FAILS on Store installs because
REM %PROGRAMFILES%\WindowsApps is ACL-restricted -- dir returns nothing even though the package is
REM present, and the script then reports "TradingView not found" AFTER it has already killed the
REM running instance. Ask the package manager first; it is authoritative and needs no ACL access.
if "%TV_EXE%"=="" (
    for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "$p=Get-AppxPackage ^| Where-Object { $_.Name -like '*TradingView*' } ^| Select-Object -First 1; if ($p) { Join-Path $p.InstallLocation 'TradingView.exe' }"`) do set "TV_EXE=%%i"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('dir /s /b "%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe" 2^>nul') do set "TV_EXE=%%i"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if "%TV_EXE%"=="" (
    echo Error: TradingView not found.
    echo Checked: %%LOCALAPPDATA%%\TradingView, %%PROGRAMFILES%%\TradingView, WindowsApps
    echo.
    echo If installed elsewhere, run manually:
    echo   "C:\path\to\TradingView.exe" --remote-debugging-port=%PORT%
    exit /b 1
)

echo Found TradingView at: %TV_EXE%
REM Only now is it safe to close the running instance.
taskkill /F /IM TradingView.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

echo Waiting for CDP to become available...
ping -n 6 127.0.0.1 >nul

:check
curl -s http://localhost:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    echo Still waiting...
    ping -n 3 127.0.0.1 >nul
    goto check
)

echo.
echo CDP ready at http://localhost:%PORT%
curl -s http://localhost:%PORT%/json/version
echo.
