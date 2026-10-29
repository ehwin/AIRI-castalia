@echo off
chcp 65001 >nul
title AIRI New Stack
rem ============================================================================
rem 2026-10-28 fusion rewrite. The old body started a retired chain -- unified proxy
rem on 5050 (memory injection + Bailian TTS + LLM forwarding), local embed 11436 and
rem lemonade 13305 -- and both python paths were hardcoded to another machine's user
rem (C:/Users/yuepengcheng/.../Python310), absent here, so a double-click did nothing.
rem Today that chain is not needed:
rem   * memory injection/write is native now (castalia-engine.json -> run/Castalia-Anima);
rem   * Bailian TTS is AIRI's own alibaba-cloud-model-studio provider (cosyvoice-v2);
rem   * that 5050 proxy last wrote a log line on 2026-09-19 and nothing listens there.
rem Backup: start-airi.bat.bak-20261028-fusion
rem ASCII only on purpose: see the tray launcher note.
rem ============================================================================
set PYTHONPATH=

echo ========================================
echo   Starting the AIRI stack (tray + AIRI)
echo ========================================
echo.

rem --- [1/2] tray: memory bridges 3310-3318 / star maps 3344-3348 / LobeHub guard ---
netstat -ano | findstr ":3398" | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo [1/2] tray already running ^(port 3398^), reusing it
    goto airi
)
set "PYW="
for %%V in (313 312 311 310) do (
    if not defined PYW if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\pythonw.exe" set "PYW=%LOCALAPPDATA%\Programs\Python\Python%%V\pythonw.exe"
)
if not defined PYW for /f "delims=" %%P in ('where pythonw 2^>nul') do if not defined PYW set "PYW=%%P"
if not defined PYW (
    echo   [WARN] pythonw.exe not found; run "py -0p" to list installed Pythons.
    pause
    exit /b 1
)
start "" "%PYW%" "D:\system\AIRI\castalia\run\Castalia\scripts\castalia_tray.py"
echo [1/2] tray started via %PYW%
%SystemRoot%\System32\ping.exe -n 6 127.0.0.1 >nul

:airi
rem --- [2/2] AIRI: prefer the dev build (fork 0.12), fall back to the installed app ---
set "AIRI_ROOT=D:\system\AIRI"
set "APP=%AIRI_ROOT%\apps\stage-tamagotchi"
rem --- APP_DEBUG=0: without it shouldOpenDevTools() opens a detached DevTools window on every dev launch ---
set "APP_DEBUG=0"
if not exist "%APP%\out\main\index.js" goto installed

echo [2/2] starting dev build ^(fork 0.12: memory injection / relationship gate / crisis handling^)
set "PATH=%AIRI_ROOT%\.cache\bin;%PATH%"
set "ELECTRON="
pushd "%APP%"
for /f "delims=" %%E in ('pnpm.cmd exec node -p "require('electron')" 2^>nul') do set "ELECTRON=%%E"
popd
if not defined ELECTRON (
    echo   [WARN] could not resolve electron.exe; using the installed app instead.
    goto installed
)
if not exist "%ELECTRON%" (
    echo   [WARN] electron path missing: %ELECTRON%
    goto installed
)
start "" "%ELECTRON%" "%APP%"
goto done

:installed
echo [2/2] starting installed app D:\system\AIRI\_legacy-0.11\airi.exe ^(0.11, without the new features^)
if not exist "D:\system\AIRI\_legacy-0.11\airi.exe" (
    echo   [ERROR] installed app not found either. Build the dev app first:
    echo           pnpm -F @proj-airi/stage-tamagotchi build   ^(in D:\system\AIRI^)
    pause
    exit /b 1
)
start "" "D:\system\AIRI\_legacy-0.11\airi.exe"

:done
echo.
echo ========================================
echo   Started.
echo   Memory engine: D:\system\AIRI\castalia\run\Castalia-Anima  ^(spawned by AIRI via castalia-engine.json^)
echo   Not started:   5050 unified proxy / local embed 11436 / lemonade 13305  --  retired
echo   Tray status:   http://127.0.0.1:3398/status
echo ========================================
%SystemRoot%\System32\ping.exe -n 6 127.0.0.1 >nul
exit
