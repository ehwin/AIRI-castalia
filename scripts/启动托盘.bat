@echo off
chcp 65001 >nul
title Castalia Tray
rem Castalia federation tray launcher (AIRI / Hermes / LobeHub share one icon).
rem Key: clear PYTHONPATH pollution + start detached from this session.
rem
rem 2026-10-28 fusion fix: the python path is no longer hardcoded to another machine's
rem user/version. It used to point at C:/Users/yuepengcheng/.../Python310/pythonw.exe,
rem which does not exist here, so a double-click flashed and did nothing.
rem Original kept beside this file with suffix .bak-20261028-fusion
rem
rem ASCII only on purpose: cmd parses this file in the console code page, and the CJK
rem text that used to be here got split mid-line and produced
rem "'...' is not recognized as an internal or external command".
rem
rem Confirmation uses the control port, not tasklist: the tray is single-instance by
rem port identity (127.0.0.1:3398) and a process-name scan is unreliable.

set PYTHONPATH=
set "PYW="
for %%V in (313 312 311 310) do (
    if not defined PYW if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\pythonw.exe" set "PYW=%LOCALAPPDATA%\Programs\Python\Python%%V\pythonw.exe"
)
if not defined PYW for /f "delims=" %%P in ('where pythonw 2^>nul') do if not defined PYW set "PYW=%%P"
if not defined PYW (
    echo   [WARN] pythonw.exe not found; run "py -0p" to list the installed Pythons.
    pause
    exit /b 1
)

netstat -ano | findstr ":3398" | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo   Tray already running ^(control port 3398^).
    goto report
)
start "" "%PYW%" "D:\system\AIRI\castalia\run\Castalia\scripts\castalia_tray.py"
echo   Tray start requested via %PYW%

:report
ping -n 4 127.0.0.1 >nul
netstat -ano | findstr ":3398" | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo   OK: control port 3398 is listening; the icon is in the notification area.
    echo   Left click opens the federation map; each side's own map is under right click.
) else (
    echo   [WARN] port 3398 is not listening. Log:
    echo          D:\system\AIRI\castalia\run\Castalia\scripts\castalia-tray.log
)
echo.
ping -n 3 127.0.0.1 >nul
exit
