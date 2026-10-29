chcp 65001 >nul
@echo off
title AIRI Unified Proxy

echo ========================================
echo   AIRI Unified Proxy (LLM+TTS+Memory)
echo ========================================
echo.
rem Kill old proxies
taskkill /F /FI "WINDOWTITLE eq Bailian-TTS-Proxy*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq AIRI Unified Proxy*" >nul 2>&1
rem 清除 PYTHONPATH 污染
set PYTHONPATH=
rem Check Ollama
echo [1/3] Checking Ollama (embedding)...
curl -s -o nul http://127.0.0.1:11434/api/tags 2>nul
if %ERRORLEVEL% neq 0 (
    echo   ^! Ollama not running. Start it first.
    pause
    exit /b 1
)
echo   OK
rem Check Lemonade
echo [2/3] Checking Lemonade (0.8B analyzer)...
curl -s -o nul http://127.0.0.1:13305/v1/models 2>nul
if %ERRORLEVEL% neq 0 (
    echo   ^! Lemonade not running. Memory analysis will be skipped.
    echo     (conversations still logged, but no auto-extraction)
) else (
    echo   OK
)
rem Start unified proxy
echo [3/3] Starting Unified Proxy...
start "AIRI Unified Proxy" /min cmd /c "set ANIMA_DIR=D:\AI\castalia\run\Castalia-Anima
set MEMORY_DIR=D:\AI\castalia\memory-banks\airi
set MEMORY_DB_DIR=D:\AI\castalia\memory-banks\airi
set CHAR_ID=airi
set CASTALIA_PROJECT=airi
start "AIRI Unified Proxy" /min cmd /c "python D:\system\AIRI\unified-proxy\proxy.py""

ping -n 3 127.0.0.1 >nul
rem Start AIRI
echo.
echo Starting AIRI...
start "" "D:\system\AIRI\airi.exe"

echo.
echo ========================================
echo   All started!
echo   Proxy: http://127.0.0.1:5050/v1
echo   Health: http://127.0.0.1:5050/health
echo   Memory stats: http://127.0.0.1:5050/memory/stats
echo ========================================
echo.
timeout /t 5 >nul
exit
